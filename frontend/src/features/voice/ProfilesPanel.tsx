import { useRef, useState } from 'react';
import { Mic, Plus, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge, Dialog, DialogContent, DialogFooter } from '@/components/ui/primitives';
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/input';
import { ConfirmDialog, EmptyState } from '@/components/common/states';
import { useAction, useVoices, voiceApi } from '@/lib/queries';
import type { VoiceProfile } from '@/lib/types';

/** Saved voice profiles: prebuilt aliases and custom voices with consent-gated replication. */
export const ProfilesPanel = () => {
  const voices = useVoices();
  const [creating, setCreating] = useState(false);
  const [replicating, setReplicating] = useState<VoiceProfile | null>(null);
  const [deleting, setDeleting] = useState<VoiceProfile | null>(null);

  const create = useAction((body: any) => voiceApi.createProfile(body), { success: 'Profile saved', onSuccess: () => voices.refetch() });
  const del = useAction((id: string) => voiceApi.deleteProfile(id), { success: 'Profile deleted', onSuccess: () => voices.refetch() });
  const replicate = useAction((v: { id: string; form: FormData }) => voiceApi.replicate(v.id, v.form), {
    success: 'Voice replicated',
    onSuccess: () => voices.refetch(),
  });

  const profiles = voices.data?.profiles || [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted">
          Saved voices. Custom voices need a reference sample and recorded consent from the speaker before replication.
        </p>
        <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
          <Plus /> New profile
        </Button>
      </div>

      {!profiles.length && <EmptyState icon={Mic} title="No voice profiles" description="Save a voice so it is one click away when generating narration." />}

      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {profiles.map((p) => (
          <div key={p.id} className="rounded-md border border-line bg-panel p-3">
            <div className="flex items-center gap-2">
              <Mic className="size-4 text-accent" />
              <span className="flex-1 truncate text-xs font-medium">{p.name}</span>
              <Badge tone={p.status === 'ready' ? 'ok' : p.status === 'pending' ? 'warn' : 'danger'}>{p.status}</Badge>
              {p.kind === 'custom' && <Badge tone="accent">custom</Badge>}
            </div>
            <p className="mt-1 text-[11px] text-muted">
              {p.provider}{p.engine ? ` · ${p.engine}` : ''} · {p.voiceId} · {p.language}
            </p>
            {p.statusError && <p className="mt-1 text-[10px] text-danger">{p.statusError}</p>}
            <div className="mt-2 flex gap-1">
              <Button size="xs" variant="ghost" onClick={() => setReplicating(p)}>
                <ShieldCheck /> {p.kind === 'custom' && p.consentConfirmed ? 'Replicate again' : 'Replicate'}
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setDeleting(p)}>
                <Trash2 className="text-danger" />
              </Button>
            </div>
          </div>
        ))}
      </div>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent title="New voice profile" description="For provider prebuilt voices choose 'prebuilt'; for your own voice choose 'custom' and replicate it with consent.">
          <ProfileForm
            saving={create.isPending}
            providerVoices={voices.data?.providerVoices || []}
            onSave={(body) => create.mutate(body, { onSuccess: () => setCreating(false) })}
          />
        </DialogContent>
      </Dialog>

      <ReplicateDialog
        profile={replicating}
        onClose={() => setReplicating(null)}
        onSubmit={(form) => replicate.mutate({ id: replicating!.id, form }, { onSuccess: () => setReplicating(null) })}
        loading={replicate.isPending}
      />

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

const ProfileForm = ({ saving, providerVoices, onSave }: { saving: boolean; providerVoices: { id: string; name: string; provider: string; languages: string[] }[]; onSave: (b: any) => void }) => {
  const [f, setF] = useState({ name: '', provider: 'gemini', kind: 'prebuilt', voiceId: '', language: 'hi', description: '' });
  const options = providerVoices.filter((v) => v.provider === f.provider);
  return (
    <div className="space-y-2">
      <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Narrator voice" /></Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Provider">
          <NativeSelect value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value, voiceId: '' })}>
            <option value="gemini">Gemini TTS</option>
            <option value="local">Local TTS</option>
          </NativeSelect>
        </Field>
        <Field label="Kind">
          <NativeSelect value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            <option value="prebuilt">Prebuilt</option>
            <option value="custom">Custom (replication)</option>
          </NativeSelect>
        </Field>
      </div>
      {f.kind === 'prebuilt' ? (
        <Field label="Voice">
          <NativeSelect value={f.voiceId} onChange={(e) => setF({ ...f, voiceId: e.target.value })}>
            <option value="">choose…</option>
            {options.map((v) => (
              <option key={v.id} value={v.id}>{v.name} — {v.languages.join(', ')}</option>
            ))}
          </NativeSelect>
        </Field>
      ) : (
        <Field label="Voice id" hint="Filled automatically after replication; you may set a pending name now.">
          <Input value={f.voiceId} onChange={(e) => setF({ ...f, voiceId: e.target.value })} placeholder="my-voice" />
        </Field>
      )}
      <Field label="Language"><Input value={f.language} onChange={(e) => setF({ ...f, language: e.target.value })} placeholder="hi" /></Field>
      <Field label="Description"><Textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <DialogFooter>
        <Button variant="primary" loading={saving} disabled={!f.name.trim() || !f.voiceId} onClick={() => onSave(f)}>
          Save profile
        </Button>
      </DialogFooter>
    </div>
  );
};

const ReplicateDialog = ({ profile, onClose, onSubmit, loading }: { profile: VoiceProfile | null; onClose: () => void; onSubmit: (form: FormData) => void; loading: boolean }) => {
  const refFile = useRef<HTMLInputElement>(null);
  const conFile = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState('');
  if (!profile) return null;
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent title={`Replicate "${profile.name}"`} description="Only replicate voices you own or have explicit permission to use. Both recordings stay on record with this profile.">
        <div className="space-y-2 text-xs">
          <Field label="Reference recording (WAV/MP3, clear speech)" hint="10–60 seconds of the speaker's natural voice.">
            <Input ref={refFile} type="file" accept="audio/*" />
          </Field>
          <Field label="Consent recording" hint="The speaker stating they consent to voice replication (e.g. in Hindi: &quot;मैं अपनी आवाज़ की प्रतिकृति के लिए सहमति देता/देती हूँ&quot;).">
            <Input ref={conFile} type="file" accept="audio/*" />
          </Field>
          <Field label="Written consent note">
            <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Consent recorded from the voice owner on 2026-11-17 — spoken consent attached." />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={loading}
            onClick={() => {
              if (!refFile.current?.files?.[0] || !conFile.current?.files?.[0]) return toast.error('Both audio files are required');
              if (note.trim().length < 10) return toast.error('Describe the consent in the note');
              const form = new FormData();
              form.append('reference', refFile.current.files[0]);
              form.append('consent', conFile.current.files[0]);
              form.append('consentNote', note);
              onSubmit(form);
            }}
          >
            <Upload /> Upload & replicate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
