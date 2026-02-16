import type { CSSProperties, ReactNode } from 'react';

export interface TableRow {
  key?: string;
  style?: CSSProperties;
  cells: Array<ReactNode>;
  cellClassNames?: Array<string | undefined>;
}

interface MetricsTableProps {
  columns: string[];
  rows: Array<Array<ReactNode> | TableRow>;
  className?: string;
  columnClassNames?: Array<string | undefined>;
  ariaLabel?: string;
}

function isTableRow(row: Array<ReactNode> | TableRow): row is TableRow {
  return typeof row === 'object' && !Array.isArray(row) && 'cells' in row;
}

export function MetricsTable({ columns, rows, className, columnClassNames, ariaLabel = 'Metrics table' }: MetricsTableProps) {
  const tableClassName = className ? `table ${className}` : 'table';
  return (
    <div className="table-wrapper" role="region" aria-label={ariaLabel}>
      <table className={tableClassName}>
        <thead>
          <tr>
            {columns.map((column, columnIndex) => (
              <th key={column} scope="col" className={columnClassNames?.[columnIndex]}>
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
                  {rowData.cells.map((cell, cellIndex) => {
                    const className = [columnClassNames?.[cellIndex], rowData.cellClassNames?.[cellIndex]]
                      .filter(Boolean)
                      .join(' ');
                    return (
                      <td key={`cell-${rowIndex}-${cellIndex}`} className={className || undefined}>
                        {cell}
                      </td>
                    );
                  })}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
