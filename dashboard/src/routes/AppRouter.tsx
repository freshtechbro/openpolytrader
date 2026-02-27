import { Navigate, Route, Routes } from 'react-router-dom';

import { OpsLayout } from './OpsLayout';
import { PublicLayout } from './PublicLayout';
import { HomePage } from '../pages/public/HomePage';
import { ProductPage } from '../pages/public/ProductPage';
import { RiskSafetyPage } from '../pages/public/RiskSafetyPage';
import { ArchitecturePage } from '../pages/public/ArchitecturePage';
import { GetStartedPage } from '../pages/public/GetStartedPage';

export function AppRouter() {
  return (
    <Routes>
      <Route element={<PublicLayout />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/product" element={<ProductPage />} />
        <Route path="/risk-safety" element={<RiskSafetyPage />} />
        <Route path="/architecture" element={<ArchitecturePage />} />
        <Route path="/get-started" element={<GetStartedPage />} />
      </Route>
      <Route path="/ops/*" element={<OpsLayout />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
