import { useState } from 'react';
import { FolderKanban, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/primitives';
import { EmptyState } from '@/components/common/states';
import { useAction, useGroups } from '@/lib/queries';
import { api } from '@/lib/api';
import type { Chapter } from '@/lib/types';

/** Named chapter ranges, e.g. "The Beginning — Chapters 1 to 5", reused by PDF, story and video tools. */
export const GroupsPanel = ({ projectId, chapters }: { projectId: string; chapters: Chapter[] }) => {
  const { data: groups } = useGroups(projectId);
  const numbers = chapters.map((c) => c.number).sort((a, b) => a - b);
  const [name, setName] = useState('');
  const [start, setStart] = useState(String(numbers[0] ?? 1));
  const [end, setEnd] = useState(String(numbers[Math.min(4, numbers.length - 1)] ?? 5));
  const inRange = chapters.filter((c) => c.number >= Number(start) && c.number <= Number(end));

  const create = useAction(
    () => api.post(`/api/manga/projects/${projectId}/groups`, { name, startNumber: Number(start), endNumber: Number(end) }),
    { success: 'Group created', invalidate: [['groups', projectId]], onSuccess: () => setName('') }
  );
  const remove = useAction((id: string) => api.del(`/api/manga/groups/${id}`), { invalidate: [['groups', projectId]] });

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[360px_1fr]">
      <div className="panel flex flex-col gap-3 p-4">
        <div className="text-xs font-semibold">Create chapter group</div>
        <Field label="Group name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="The Beginning" />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Start chapter">
            <Input type="number" step="any" value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="End chapter">
            <Input type="number" step="any" value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>
        <p className="text-[11px] text-muted">
          {Number(end) < Number(start) ? <span className="text-danger">End must be ≥ start</span> : `${inRange.length} chapter(s) in range`}
        </p>
        <Button variant="primary" disabled={!name.trim() || Number(end) < Number(start)} loading={create.isPending} onClick={() => create.mutate()}>
          <Plus /> Create group
        </Button>
      </div>
      <div className="flex flex-col gap-2">
        {!groups?.length ? (
          <EmptyState icon={FolderKanban} title="No groups yet" description="Groups name a chapter range (e.g. an arc) for PDF export, story generation and videos." />
        ) : (
          groups.map((g) => {
            const count = chapters.filter((c) => c.number >= g.startNumber && c.number <= g.endNumber).length;
            return (
              <div key={g.id} className="panel flex items-center justify-between gap-3 px-4 py-3">
                <div>
                  <div className="text-sm font-medium">{g.name}</div>
                  <div className="text-xs text-muted">
                    Chapters {g.startNumber} to {g.endNumber}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone="info">{count} chapters</Badge>
                  <Button size="icon-sm" variant="ghost" onClick={() => remove.mutate(g.id)} aria-label="Delete group">
                    <Trash2 />
                  </Button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
