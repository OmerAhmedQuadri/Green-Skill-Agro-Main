import type { ReactNode, TdHTMLAttributes } from 'react';

export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-stone-50 text-xs uppercase tracking-wide text-stone-500">
          <tr>{head.map((h, i) => <th key={i} className="px-4 py-2.5 text-start font-medium">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-stone-100">{children}</tbody>
      </table>
    </div>
  );
}

/**
 * Forwards whatever else it is given to the `<td>`. It used to accept only
 * `children` and `className`, which silently swallowed `data-testid` — a test
 * then waited for an element that could never appear, until the whole run
 * timed out. `Badge` and `Alert` already spread; this matches them.
 */
export const Cell = ({ children, className = '', ...props }: TdHTMLAttributes<HTMLTableCellElement>) => (
  <td className={`px-4 py-3 align-top ${className}`} {...props}>{children}</td>
);
