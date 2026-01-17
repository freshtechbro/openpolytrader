import type { CSSProperties, ReactNode } from 'react';

export interface TableRow {
  key?: string;
  style?: CSSProperties;
  cells: Array<ReactNode>;
}

interface MetricsTableProps {
  columns: string[];
  rows: Array<Array<ReactNode> | TableRow>;
}

function isTableRow(row: Array<ReactNode> | TableRow): row is TableRow {
  return typeof row === 'object' && !Array.isArray(row) && 'cells' in row;
}

export function MetricsTable({ columns, rows }: MetricsTableProps) {
  return (
    <div className="table-wrapper" role="region" aria-label="Metrics table">
      <table className="table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="table__empty">
                No data yet
              </td>
            </tr>
          ) : (
            rows.map((row, rowIndex) => {
              const rowData = isTableRow(row) ? row : { cells: row };
              const rowKey = isTableRow(row) && row.key ? row.key : `row-${rowIndex}`;
              const rowStyle = isTableRow(row) ? row.style : undefined;
              return (
                <tr key={rowKey} style={rowStyle}>
                  {rowData.cells.map((cell, cellIndex) => (
                    <td key={`cell-${rowIndex}-${cellIndex}`}>{cell}</td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
