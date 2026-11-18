import { useState } from 'react';
import { Download, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge, Dialog, DialogContent, DialogFooter } from '@/components/ui/primitives';
import { Field, Input, Textarea } from '@/components/ui/input';
import { ConfirmDialog, EmptyState, LoadingState } from '@/components/common/states';
import { useAction, useCharacters } from '@/lib/queries';
import { api } from '@/lib/api';
import type { StoryCharacter } from '@/lib/types';

/** Project character registry — built by analysis, editable by the user. */
export const CharactersPanel = ({ projectId }: { projectId: string }) => {
  const chars = useCharacters(projectId);
  const [editing, setEditing] = useState<StoryCharacter | 'new' | null>(null);
  const [deleting, setDeleting] = useState<StoryCharacter | null>(null);

  const save = useAction((v: { id?: string; body: any }) => (v.id ? api.put(`/api/story/characters/${v.id}`, v.body) : api.post(`/api/story/projects/${projectId}/characters`, v.body)), {
    success: 'Character saved',
    onSuccess: () => chars.refetch(),
  });
  const del = useAction((id: string) => api.del(`/api/story/characters/${id}`), { success: 'Character deleted', onSuccess: () => chars.refetch() });
  const importMeta = useAction(() => api.post(`/api/manga/projects/${projectId}/fetch-metadata`), {
    success: 'Metadata imported',
    onSuccess: (r: any) => { if (r?.charactersImported === 0) { /* toast handled by useAction */ } chars.refetch(); },
  });

  if (chars.isLoading) return <LoadingState />;
  const list = chars.data || [];

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted">{list.length} characters tracked for continuity</span>
        <div className="flex gap-1">
          <Button size="xs" variant="outline" loading={importMeta.isPending} onClick={() => importMeta.mutate(undefined)}><Download /> Import</Button>
          <Button size="xs" variant="outline" onClick={() => setEditing('new')}><Plus /> Add</Button>
        </div>
      </div>
      {!list.length && <EmptyState icon={Pencil} title="No characters" description="Characters appear after scene analysis, or add them manually." />}
      {list.map((c) => (
        <div key={c.id} className="rounded-md border border-line bg-panel p-2.5">
          <div className="flex items-center gap-2">
            {c.external?.imageUrl ? (
              <img src={c.external.imageUrl} alt="" className="size-6 rounded-full object-cover" />
            ) : (
              <span className="flex size-6 items-center justify-center rounded-full bg-panel-3 text-[10px] font-bold">{c.name.slice(0, 2).toUpperCase()}</span>
            )}
            <span className="flex-1 truncate text-xs font-medium">{c.name}</span>
            {c.role && <span className="text-[9px] text-muted">{c.role}</span>}
            {c.source === 'user' && <Badge tone="accent">manual</Badge>}
            {c.source === 'api' && <Badge tone="ok">MAL</Badge>}
            <Button size="xs" variant="ghost" onClick={() => setEditing(c)}><Pencil /></Button>
            <Button size="xs" variant="ghost" onClick={() => setDeleting(c)}><Trash2 className="text-danger" /></Button>
          </div>
          {c.aliases.length > 0 && <p className="mt-1 text-[10px] text-muted">aka {c.aliases.join(', ')}</p>}
          {c.description && <p className="mt-1 line-clamp-2 text-[11px] text-muted">{c.description}</p>}
          {(c.firstChapter || c.lastChapter) && (
            <p className="mt-1 text-[10px] text-muted">ch. {c.firstChapter}{c.lastChapter && c.lastChapter !== c.firstChapter ? `–${c.lastChapter}` : ''}</p>
          )}
        </div>
      ))}

      <Dialog open={!!editing} onOpenChange={() => setEditing(null)}>
        <DialogContent title={editing === 'new' ? 'New character' : `Edit ${editing ? (editing as StoryCharacter).name : ''}`}>
          {editing && (
            <CharacterForm
              initial={editing === 'new' ? undefined : editing}
              saving={save.isPending}
              onSave={(body) => save.mutate({ id: editing === 'new' ? undefined : editing.id, body }, { onSuccess: () => setEditing(null) })}
            />
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={() => setDeleting(null)}
        title={`Delete ${deleting?.name}?`}
        confirmLabel="Delete"
        danger
        loading={del.isPending}
        onConfirm={() => del.mutate(deleting!.id, { onSuccess: () => setDeleting(null) })}
      />
    </div>
  );
};

const CharacterForm = ({ initial, onSave, saving }: { initial?: StoryCharacter; onSave: (body: any) => void; saving: boolean }) => {
  const [f, setF] = useState({
    name: initial?.name || '',
    aliases: (initial?.aliases || []).join(', '),
    role: initial?.role || '',
    description: initial?.description || '',
    pronunciation: initial?.pronunciation || '',
  });
  return (
    <div className="space-y-2">
      <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label="Aliases (comma separated)"><Input value={f.aliases} onChange={(e) => setF({ ...f, aliases: e.target.value })} /></Field>
      <Field label="Role"><Input value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} placeholder="protagonist / rival / mentor" /></Field>
      <Field label="Description"><Textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <Field label="Pronunciation hint" hint="Used by narration and TTS."><Input value={f.pronunciation} onChange={(e) => setF({ ...f, pronunciation: e.target.value })} /></Field>
      <DialogFooter>
        <Button variant="primary" loading={saving} disabled={!f.name.trim()} onClick={() => onSave({ ...f, aliases: f.aliases.split(',').map((a) => a.trim()).filter(Boolean) })}>
          Save
        </Button>
      </DialogFooter>
    </div>
  );
};
