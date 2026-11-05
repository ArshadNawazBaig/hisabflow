// Production PWA behavior in a loopback-only fixture. Never imported by a route.
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import HisabApp from '../../components/hisab/hisab-app';
import { InstallAppButton, PwaProvider, usePwaSaveGuard } from '../../components/hisab/pwa-support';
import '../../app/globals.css';
import '../../app/typography.css';

const installOnly = new URLSearchParams(location.search).has('install');
function InstallFixture() {
  const [unsaved,setUnsaved]=useState(false);
  usePwaSaveGuard(unsaved);
  return <main style={{padding:24}}><h1>Install fixture</h1><InstallAppButton/><label><input type="checkbox" checked={unsaved} onChange={event=>setUnsaved(event.target.checked)}/>Unsaved fixture changes</label></main>;
}
createRoot(document.getElementById('root')!).render(
  <PwaProvider>
    {installOnly ? <InstallFixture/> : <HisabApp/>}
  </PwaProvider>,
);
