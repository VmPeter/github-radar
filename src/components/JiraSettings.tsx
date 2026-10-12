import { useEffect, useState, type FormEvent } from 'react';
import { jiraRequest, type JiraConfig } from '../lib/jira';
import { inferJiraKind, type JiraKind } from '../lib/jiraTypes';

export function JiraSettings({ config, onSaved, onClose }: { config: JiraConfig; onSaved: () => void; onClose: () => void }) {
  const [site, setSite] = useState(config.site);
  const [email, setEmail] = useState(config.email);
  const [token, setToken] = useState('');
  const [connection, setConnection] = useState<JiraKind | 'auto'>(config.kind ?? 'auto');
  const [detected, setDetected] = useState<{ input: string; site: string; kind: JiraKind }>();
  const detection = detected?.input === site ? detected : undefined;
  const kind = connection === 'auto' ? detection?.kind ?? inferJiraKind(site) : connection;
  useEffect(() => {
    if (connection !== 'auto') return;
    try { if (new URL(site).protocol !== 'https:') return; } catch { return; }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void jiraRequest<{ site: string; kind: JiraKind }>('site', 'POST', { site }, controller.signal)
        .then(result => { if (!controller.signal.aborted) setDetected({ ...result, input: site }); })
        .catch(() => {});
    }, 400);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [site, connection]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { await jiraRequest('config', 'POST', { site: connection === 'auto' ? detection?.site ?? site : site, email, token, ...(connection === 'auto' ? {} : { kind }) }); onSaved(); onClose(); }
    catch (error) { setError(error instanceof Error ? error.message : 'Connection failed.'); }
    finally { setBusy(false); }
  }
  async function disconnect() {
    setBusy(true); setError('');
    try { await jiraRequest('config', 'DELETE'); onSaved(); onClose(); }
    catch (error) { setError(error instanceof Error ? error.message : 'Disconnect failed.'); }
    finally { setBusy(false); }
  }
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/70 p-4">
    <form onSubmit={save} role="dialog" aria-modal="true" aria-labelledby="jira-settings-title" className="card w-full max-w-lg space-y-4 p-6">
      <h2 id="jira-settings-title" className="text-lg font-semibold">Connect Jira</h2>
      <p className="text-sm text-slate-500">Connect Jira to read issues and their epics. The token stays on this computer and is never sent to GitHub.</p>
      <label className="block text-sm">Jira site<input autoFocus required type="url" placeholder="https://jira.prod.vipps.io" value={site} onChange={event => setSite(event.target.value)} className="input mt-1 w-full" /></label>
      {connection === 'auto' && detection?.site !== site && detection && <p className="text-sm text-slate-500">Jira Cloud detected. Connecting through {detection.site}.</p>}
      <label className="block text-sm">Connection type<select className="input mt-1 w-full" value={connection} onChange={event => setConnection(event.target.value as JiraKind | 'auto')}>
        <option value="auto">Automatic ({kind === 'cloud' ? 'Jira Cloud' : 'Jira Data Center'})</option>
        <option value="cloud">Jira Cloud</option><option value="datacenter">Jira Data Center / Server</option>
      </select></label>
      {(kind === 'cloud' || connection === 'auto' && !detection) && <label className="block text-sm">Email<input required={kind === 'cloud'} type="email" autoComplete="username" value={email} onChange={event => setEmail(event.target.value)} className="input mt-1 w-full" /></label>}
      <label className="block text-sm">{kind === 'cloud' ? 'API token' : 'Personal access token'}<input required type="password" autoComplete="new-password" value={token} onChange={event => setToken(event.target.value)} className="input mt-1 w-full" /></label>
      {kind === 'cloud' ? <a className="text-sm underline" href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noreferrer">Create an Atlassian API token without scopes</a>
        : <p className="text-sm text-slate-500">In your Jira profile, open Personal Access Tokens and create a token for Radar. No email is needed.</p>}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <div className="flex items-center gap-3 text-sm">
        <button type="submit" disabled={busy} className="rounded bg-slate-900 px-3 py-2 text-white disabled:opacity-50">{busy ? 'Connecting…' : 'Connect'}</button>
        <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
        {config.configured && <button type="button" disabled={busy} onClick={disconnect} className="ml-auto text-red-600">Disconnect</button>}
      </div>
    </form>
  </div>;
}
