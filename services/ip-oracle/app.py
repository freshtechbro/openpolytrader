#!/usr/bin/env python3
"""OR-Tools CP-SAT sidecar for FW integer projection solves."""

from __future__ import annotations

import os
import time
import math
from decimal import Decimal
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from ortools.sat.python import cp_model
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class Objective(BaseModel):
    variables: list[str] = Field(min_length=1)
    coefficients: list[float] = Field(min_length=1)
    sense: Literal["min", "max"]

    @model_validator(mode="after")
    def validate_lengths(self) -> "Objective":
        if len(self.variables) != len(self.coefficients):
            raise ValueError("objective.variables and objective.coefficients length mismatch")
        if len(set(self.variables)) != len(self.variables):
            raise ValueError("objective.variables must be unique")
        return self


class ConstraintRow(BaseModel):
    coefficients: list[float]
    op: Literal["<=", ">=", "="]
    rhs: float


class Constraints(BaseModel):
    type: Literal["linear_binary"]
    rows: list[ConstraintRow] = Field(default_factory=list)


class WarmStartHint(BaseModel):
    variables: list[str] = Field(min_length=1)
    values: list[float] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_lengths(self) -> "WarmStartHint":
        if len(self.variables) != len(self.values):
            raise ValueError("warmStartHint.variables and warmStartHint.values length mismatch")
        return self


class SolveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    requestId: str = Field(min_length=1)
    loopId: str | None = None
    iteration: int | None = Field(default=None, ge=0, le=10000)
    timeLimitMs: int = Field(gt=0, le=30000)
    seed: int | None = None
    objective: Objective
    constraints: Constraints
    warmStartHint: WarmStartHint | None = None

    @field_validator("requestId")
    @classmethod
    def normalize_request_id(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("requestId cannot be blank")
        return normalized


class SolveDiagnostics(BaseModel):
    conflicts: int | None = None
    branches: int | None = None
    restarts: int | None = None


class SolveResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    requestId: str
    loopId: str | None = None
    iteration: int | None = None
    status: Literal["optimal", "feasible", "infeasible", "timeout", "error", "unknown"]
    objectiveValue: float | None = None
    bestBound: float | None = None
    assignment: dict[str, int] | None = None
    gap: float | None = None
    relativeGap: float | None = None
    runtimeMs: int
    diagnostics: SolveDiagnostics | None = None
    error: str | None = None


MAX_REQUEST_BYTES = max(int(os.getenv("IP_ORACLE_MAX_REQUEST_BYTES", "65536")), 1024)
API_KEY = os.getenv("IP_ORACLE_API_KEY", "").strip()

app = FastAPI(title="openpolytrader-ip-oracle", version="1.0.0")


@app.middleware("http")
async def enforce_request_size(request: Request, call_next):
    if request.method == "POST" and request.url.path == "/solve":
        content_length = request.headers.get("content-length")
        if content_length is not None:
            try:
                if int(content_length) > MAX_REQUEST_BYTES:
                    raise HTTPException(status_code=413, detail="request_too_large")
            except ValueError:
                raise HTTPException(status_code=400, detail="invalid_content_length")
    return await call_next(request)


def require_auth(authorization: str | None = Header(default=None)) -> None:
    if not API_KEY:
        return
    if not authorization:
        raise HTTPException(status_code=401, detail="missing_authorization")
    prefix = "bearer "
    if not authorization.lower().startswith(prefix):
        raise HTTPException(status_code=401, detail="invalid_authorization_format")
    token = authorization[len(prefix) :].strip()
    if token != API_KEY:
        raise HTTPException(status_code=401, detail="invalid_api_key")


@app.get("/health")
def health() -> dict[str, object]:
    return {
        "ok": True,
        "service": "ip-oracle",
        "backend": "ortools-cp-sat",
        "maxRequestBytes": MAX_REQUEST_BYTES,
        "authEnabled": bool(API_KEY),
    }


@app.post("/solve", response_model=SolveResponse)
def solve(request: SolveRequest, _auth: None = Depends(require_auth)) -> SolveResponse:
    started = time.perf_counter()
    try:
        response = solve_request(request)
    except ValueError as error:
        runtime_ms = int((time.perf_counter() - started) * 1000)
        return SolveResponse(
            requestId=request.requestId,
            loopId=request.loopId,
            iteration=request.iteration,
            status="error",
            runtimeMs=runtime_ms,
            error=str(error),
        )
    except Exception as error:  # pragma: no cover - defensive catch for runtime faults
        runtime_ms = int((time.perf_counter() - started) * 1000)
        return SolveResponse(
            requestId=request.requestId,
            loopId=request.loopId,
            iteration=request.iteration,
            status="error",
            runtimeMs=runtime_ms,
            error=f"solver_exception:{type(error).__name__}",
        )

    runtime_ms = int((time.perf_counter() - started) * 1000)
    response.runtimeMs = runtime_ms
    return response


def solve_request(request: SolveRequest) -> SolveResponse:
    model = cp_model.CpModel()
    variables = {
        name: model.NewBoolVar(name)
        for name in request.objective.variables
    }
    variable_names = request.objective.variables

    for row in request.constraints.rows:
        if len(row.coefficients) != len(variable_names):
            raise ValueError("constraint.coefficients length mismatch")
        scaled_row_values, _row_scale = scale_to_integers([*row.coefficients, row.rhs])
        scaled_coefficients = scaled_row_values[:-1]
        scaled_rhs = scaled_row_values[-1]
        expr = sum(
            coefficient * variables[variable_names[index]]
            for index, coefficient in enumerate(scaled_coefficients)
        )
        if row.op == "<=":
            model.Add(expr <= scaled_rhs)
        elif row.op == ">=":
            model.Add(expr >= scaled_rhs)
        else:
            model.Add(expr == scaled_rhs)

    objective_coefficients, objective_scale = scale_to_integers(
        request.objective.coefficients
    )
    objective_expr = sum(
        coefficient * variables[name]
        for name, coefficient in zip(variable_names, objective_coefficients, strict=True)
    )
    if request.objective.sense == "min":
        model.Minimize(objective_expr)
    else:
        model.Maximize(objective_expr)

    if request.warmStartHint:
        for name, value in zip(
            request.warmStartHint.variables, request.warmStartHint.values, strict=True
        ):
            variable = variables.get(name)
            if variable is None:
                continue
            model.AddHint(variable, 1 if value >= 0.5 else 0)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = min(max(request.timeLimitMs, 1), 30000) / 1000.0
    solver.parameters.num_search_workers = max(int(os.getenv("IP_ORACLE_WORKERS", "1")), 1)
    if request.seed is not None:
        solver.parameters.random_seed = request.seed

    status_code = solver.Solve(model)
    status = map_status(status_code, request.timeLimitMs)
    diagnostics = SolveDiagnostics(
        conflicts=solver_stat(solver, "NumConflicts"),
        branches=solver_stat(solver, "NumBranches"),
        restarts=solver_stat(solver, "NumRestarts"),
    )

    if status not in {"optimal", "feasible"}:
        return SolveResponse(
            requestId=request.requestId,
            loopId=request.loopId,
            iteration=request.iteration,
            status=status,
            runtimeMs=0,
            diagnostics=diagnostics,
            error=None if status in {"infeasible", "timeout"} else "solve_failed",
        )

    assignment = {name: int(solver.Value(variables[name])) for name in variable_names}
    objective_value = float(solver.ObjectiveValue()) / objective_scale
    best_bound = float(solver.BestObjectiveBound()) / objective_scale
    abs_gap = abs(objective_value - best_bound)
    denom = max(abs(objective_value), 1e-9)
    relative_gap = abs_gap / denom

    return SolveResponse(
        requestId=request.requestId,
        loopId=request.loopId,
        iteration=request.iteration,
        status=status,
        objectiveValue=objective_value,
        bestBound=best_bound,
        assignment=assignment,
        gap=abs_gap,
        relativeGap=relative_gap,
        runtimeMs=0,
        diagnostics=diagnostics,
        error=None,
    )


def map_status(status_code: int, time_limit_ms: int) -> Literal[
    "optimal", "feasible", "infeasible", "timeout", "error", "unknown"
]:
    if status_code == cp_model.OPTIMAL:
        return "optimal"
    if status_code == cp_model.FEASIBLE:
        return "feasible"
    if status_code == cp_model.INFEASIBLE:
        return "infeasible"
    if status_code == cp_model.MODEL_INVALID:
        return "error"
    if status_code == cp_model.UNKNOWN:
        return "timeout" if time_limit_ms > 0 else "unknown"
    return "unknown"


def scale_to_integers(values: list[float], max_scale: int = 1_000_000) -> tuple[list[int], int]:
    if not values:
        return [], 1

    scale = 1
    for value in values:
        decimal_value = Decimal(str(value))
        exponent = decimal_value.as_tuple().exponent
        required = 10 ** max(0, -exponent)
        scale = math.lcm(scale, required)
        if scale >= max_scale:
            scale = max_scale
            break

    scaled = [int(round(value * scale)) for value in values]
    return scaled, scale


def solver_stat(solver: cp_model.CpSolver, method_name: str) -> int | None:
    method = getattr(solver, method_name, None)
    if callable(method):
        return int(method())
    return None


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=os.getenv("IP_ORACLE_HOST", "127.0.0.1"),
        port=int(os.getenv("IP_ORACLE_PORT", "7071")),
        log_level=os.getenv("IP_ORACLE_LOG_LEVEL", "info"),
        workers=1,
    )
