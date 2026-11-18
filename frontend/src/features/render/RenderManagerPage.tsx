import { MonitorPlay } from 'lucide-react';
import { PageHeader } from '@/components/common/states';
import { JobsPanel } from './JobsPanel';

export const RenderManagerPage = () => (
  <div>
    <PageHeader icon={MonitorPlay} title="Render Manager" subtitle="Live status of every background job — renders, audio, AI analysis, extraction and PDF" />
    <div className="flex flex-col gap-6 p-6">
      <JobsPanel />
    </div>
  </div>
);
