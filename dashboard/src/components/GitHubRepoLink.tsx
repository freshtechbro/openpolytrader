import { PUBLIC_REPO_URL } from '../lib/dashboardConfig';

interface GitHubRepoLinkProps {
  className?: string;
}

export function GitHubRepoLink({ className }: GitHubRepoLinkProps) {
  const classes = ['github-repo-link', className].filter(Boolean).join(' ');

  return (
    <a
      className={classes}
      href={PUBLIC_REPO_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Open OpenPolyTrader GitHub repository"
      title="Open OpenPolyTrader GitHub repository"
    >
      <svg viewBox="0 0 16 16" role="img" aria-hidden="true">
        <path d="M8 0C3.58 0 0 3.73 0 8.33c0 3.67 2.29 6.79 5.47 7.88.4.08.55-.18.55-.4 0-.2-.01-.85-.01-1.54-2.01.38-2.53-.51-2.69-.98-.09-.25-.47-.98-.8-1.17-.27-.15-.66-.52-.01-.53.61-.01 1.05.59 1.19.83.69 1.22 1.79.88 2.23.67.07-.52.27-.88.5-1.08-1.78-.21-3.64-.92-3.64-4.11 0-.91.31-1.66.82-2.25-.08-.21-.36-1.07.08-2.23 0 0 .67-.22 2.2.86a7.3 7.3 0 0 1 4 0c1.53-1.09 2.2-.86 2.2-.86.44 1.16.16 2.02.08 2.23.51.59.82 1.33.82 2.25 0 3.2-1.87 3.9-3.65 4.11.29.25.54.73.54 1.49 0 1.08-.01 1.95-.01 2.22 0 .22.14.49.55.4A8.33 8.33 0 0 0 16 8.33C16 3.73 12.42 0 8 0Z" />
      </svg>
    </a>
  );
}
