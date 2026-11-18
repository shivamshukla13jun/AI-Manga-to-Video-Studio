import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from '@/stores/auth';
import { AppShell } from '@/components/layout/AppShell';
import { AuthPage } from '@/features/auth/AuthPage';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { LibraryPage } from '@/features/library/LibraryPage';
import { ProjectPage } from '@/features/library/ProjectPage';
import { PdfConverterPage } from '@/features/pdf/PdfConverterPage';
import { RenderManagerPage } from '@/features/render/RenderManagerPage';
import { StoryStudioPage } from '@/features/story/StoryStudioPage';
import { VoiceStudioPage } from '@/features/voice/VoiceStudioPage';
import { VideoStudioPage } from '@/features/video/VideoStudioPage';
import { SettingsPage } from '@/features/settings/SettingsPage';

const RequireAuth = ({ children }: { children: React.ReactNode }) => {
  const token = useAuth((s) => s.accessToken);
  const location = useLocation();
  if (!token) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
};

export const App = () => (
  <Routes>
    <Route path="/login" element={<AuthPage mode="login" />} />
    <Route path="/register" element={<AuthPage mode="register" />} />
    <Route
      element={
        <RequireAuth>
          <AppShell />
        </RequireAuth>
      }
    >
      <Route index element={<DashboardPage />} />
      <Route path="library" element={<LibraryPage />} />
      <Route path="library/:projectId" element={<ProjectPage />} />
      <Route path="pdf" element={<PdfConverterPage />} />
      <Route path="renders" element={<RenderManagerPage />} />
      <Route path="story" element={<StoryStudioPage />} />
      <Route path="story/:projectId" element={<StoryStudioPage />} />
      <Route path="video" element={<VideoStudioPage />} />
      <Route path="video/:videoId" element={<VideoStudioPage />} />
      <Route path="voice" element={<VoiceStudioPage />} />
      <Route path="voice/:projectId" element={<VoiceStudioPage />} />
      <Route path="settings" element={<SettingsPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Route>
  </Routes>
);
