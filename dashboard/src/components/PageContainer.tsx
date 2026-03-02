import type { ReactNode } from 'react';

interface PageContainerProps {
  children: ReactNode;
  className?: string;
}

export function PageContainer({ children, className }: PageContainerProps) {
  return <main className={className ? `page-container ${className}` : 'page-container'}>{children}</main>;
}
