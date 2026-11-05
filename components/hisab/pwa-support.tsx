'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ArrowDownToLine, Check, Download, RefreshCw, Share, Smartphone, WifiOff, X } from 'lucide-react';
import { Modal } from './modal';
import './pwa-support.css';

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };
type PwaContextValue = { installed: boolean; installing: boolean; install: () => void; setUnsaved: (value: boolean) => void };
const PwaContext = createContext<PwaContextValue | null>(null);
const serverOnline = () => true;
const serverInstalled = () => false;
const onlineSnapshot = () => navigator.onLine;
const installedSnapshot = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
function subscribeConnection(callback: () => void) {
  window.addEventListener('online', callback); window.addEventListener('offline', callback);
  return () => { window.removeEventListener('online', callback); window.removeEventListener('offline', callback); };
}
function subscribeDisplayMode(callback: () => void) {
  const mode = window.matchMedia('(display-mode: standalone)'); mode.addEventListener('change', callback);
  return () => mode.removeEventListener('change', callback);
}

/** Install and update the public app shell; financial records stay with the authenticated API. */
export function PwaProvider({ children }: { children: ReactNode }) {
  const online = useSyncExternalStore(subscribeConnection, onlineSnapshot, serverOnline);
  const standalone = useSyncExternalStore(subscribeDisplayMode, installedSnapshot, serverInstalled);
  const [installed, setInstalled] = useState(false), [installing, setInstalling] = useState(false);
  const [instructions, setInstructions] = useState(false), [installError, setInstallError] = useState('');
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null), [updateHidden, setUpdateHidden] = useState(false);
  const [hasUnsaved, setUnsaved] = useState(false), [offlineHidden, setOfflineHidden] = useState(false);
  const prompt = useRef<InstallPrompt | null>(null), refreshRequested = useRef(false);

  useEffect(() => {
    const available = (event: Event) => { event.preventDefault(); prompt.current = event as InstallPrompt; };
    const completed = () => { prompt.current = null; setInstalled(true); setInstructions(false); };
    const connection = () => setOfflineHidden(false);
    window.addEventListener('beforeinstallprompt', available); window.addEventListener('appinstalled', completed);
    window.addEventListener('online', connection); window.addEventListener('offline', connection);
    return () => {
      window.removeEventListener('beforeinstallprompt', available); window.removeEventListener('appinstalled', completed);
      window.removeEventListener('online', connection); window.removeEventListener('offline', connection);
    };
  }, []);

  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !window.isSecureContext || !('serviceWorker' in navigator)) return;
    let disposed = false, registration: ServiceWorkerRegistration | undefined, installingWorker: ServiceWorker | null = null;
    let lastCheck = Date.now();
    const ready = () => {
      if (!disposed && registration?.waiting && navigator.serviceWorker.controller) { setWaiting(registration.waiting); setUpdateHidden(false); }
    };
    const found = () => { installingWorker?.removeEventListener('statechange', ready); installingWorker = registration?.installing || null; installingWorker?.addEventListener('statechange', ready); };
    const visible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastCheck > 300000) { lastCheck = Date.now(); void registration?.update().catch(() => {}); }
    };
    const controlled = () => { if (refreshRequested.current) window.location.reload(); };
    navigator.serviceWorker.addEventListener('controllerchange', controlled);
    void navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).then(value => {
      if (disposed) return;
      registration = value; ready(); found(); registration.addEventListener('updatefound', found);
      document.addEventListener('visibilitychange', visible);
    }).catch(() => { /* Installation is optional; the online app remains usable. */ });
    return () => {
      disposed = true; registration?.removeEventListener('updatefound', found); installingWorker?.removeEventListener('statechange', ready);
      document.removeEventListener('visibilitychange', visible); navigator.serviceWorker.removeEventListener('controllerchange', controlled);
    };
  }, []);

  const install = useCallback(async () => {
    if (installed || standalone || installing) return;
    setInstallError('');
    const event = prompt.current;
    if (!event) { setInstructions(true); return; }
    prompt.current = null; setInstalling(true);
    try {
      await event.prompt();
      const choice = await event.userChoice;
      if (choice.outcome === 'accepted') { setInstalled(true); setInstructions(false); }
    } catch { setInstallError('The installation prompt could not open. Use your browser’s menu instead.'); setInstructions(true); }
    finally { setInstalling(false); }
  }, [installed, standalone, installing]);
  const context = useMemo(() => ({ installed: installed || standalone, installing, install: () => { void install(); }, setUnsaved }), [installed, standalone, installing, install]);
  const ios = typeof navigator !== 'undefined' && (/iPad|iPhone|iPod/.test(navigator.userAgent) || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const secure = typeof window !== 'undefined' && window.isSecureContext;
  const update = () => { if (!waiting || hasUnsaved || !online) return; refreshRequested.current = true; waiting.postMessage({ type: 'SKIP_WAITING' }); };

  return <PwaContext.Provider value={context}>{children}
    {instructions && <Modal title="Install HisabFlow" className="hf-pwa-install-modal" onClose={() => setInstructions(false)}
      footer={<button type="button" className="button button-primary" onClick={() => setInstructions(false)}>Got it<Check size={16}/></button>}>
      <div className="hf-install-intro"><span><Smartphone size={24}/></span><p>Keep your workspace on your home screen and open it like an app.</p></div>
      {installError && <p className="hf-install-error" role="alert">{installError}</p>}
      {!secure ? <p className="hf-install-note">Open the secure HisabFlow address in your phone’s browser to install it.</p> : ios ? <ol className="hf-install-steps">
        <li><span>1</span><div><b>Open in Safari</b><p>Visit this HisabFlow address in Safari on your iPhone or iPad.</p></div></li>
        <li><span>2</span><div><b>Open the Share menu <Share size={16}/></b><p>Choose Add to Home Screen. You may find Share inside the browser’s More menu.</p></div></li>
        <li><span>3</span><div><b>Add HisabFlow</b><p>Keep Open as Web App enabled if shown, then tap Add.</p></div></li>
      </ol> : <ol className="hf-install-steps">
        <li><span>1</span><div><b>Open your browser’s menu</b><p>On your phone, open HisabFlow in Chrome, Edge, or another browser that supports installation.</p></div></li>
        <li><span>2</span><div><b>Choose Install app <ArrowDownToLine size={16}/></b><p>Your browser may call this Add to Home screen. On a computer, look for the install icon in the address bar.</p></div></li>
        <li><span>3</span><div><b>Confirm installation</b><p>Open HisabFlow from the new app icon whenever you need it.</p></div></li>
      </ol>}
      <p className="hf-install-note">An internet connection is needed to sign in, load records, and save changes.</p>
    </Modal>}
    {!online && !offlineHidden && <div className="hf-pwa-notice" role="status"><WifiOff size={20}/><p><b>You’re offline</b><span>Reconnect to load or save your records.</span></p><button type="button" aria-label="Dismiss offline message" onClick={() => setOfflineHidden(true)}><X size={18}/></button></div>}
    {online && waiting && !updateHidden && <div className="hf-pwa-notice hf-pwa-update" role="status"><RefreshCw size={20}/><p><b>A new version is ready</b><span>{hasUnsaved ? 'Save or retry your changes before updating.' : 'Update when you’re ready to continue.'}</span></p><div><button type="button" className="button button-primary" disabled={hasUnsaved} onClick={update}>Update</button><button type="button" aria-label="Update later" onClick={() => setUpdateHidden(true)}><X size={18}/></button></div></div>}
  </PwaContext.Provider>;
}

export function InstallAppButton({ className = '' }: { className?: string }) {
  const context = useContext(PwaContext);
  if (!context || context.installed) return null;
  return <button type="button" className={`hf-install-button ${className}`} disabled={context.installing} onClick={context.install}><Download size={17}/>{context.installing ? 'Opening install…' : 'Install app'}</button>;
}

/** Keep an app update from discarding the workspace's in-memory save queue. */
export function usePwaSaveGuard(unsaved: boolean) {
  const setUnsaved = useContext(PwaContext)?.setUnsaved;
  useEffect(() => { setUnsaved?.(unsaved); return () => setUnsaved?.(false); }, [setUnsaved, unsaved]);
}
