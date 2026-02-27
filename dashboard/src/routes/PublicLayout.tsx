import { useEffect } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { GitHubRepoLink } from '../components/GitHubRepoLink';

const PUBLIC_LINKS = [
  { to: '/', label: 'Home' },
  { to: '/product', label: 'Product' },
  { to: '/risk-safety', label: 'Risk' },
  { to: '/architecture', label: 'Architecture' },
  { to: '/get-started', label: 'Get Started' }
] as const;

export function PublicLayout() {
  const location = useLocation();

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [location.pathname]);

  return (
    <div className="public-shell">
      <header className="public-header">
        <div className="public-header__brand">
          <GitHubRepoLink />
          <NavLink to="/" className="brand-link">
            OpenPolyTrader
          </NavLink>
        </div>
        <nav aria-label="Landing navigation" className="public-header__nav">
          {PUBLIC_LINKS.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              className={({ isActive }) =>
                isActive ? 'public-link public-link--active' : 'public-link'
              }
              end={link.to === '/'}
            >
              {link.label}
            </NavLink>
          ))}
        </nav>
        <NavLink to="/ops/overview" className="ops-cta">
          Open Ops
        </NavLink>
      </header>
      <Outlet />
    </div>
  );
}
