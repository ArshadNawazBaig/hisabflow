'use client';

import { useSyncExternalStore } from 'react';
import type { View } from '@/lib/types';
import { ListSkeleton } from './infinite-list';
import './workspace-skeleton.css';

const Line = ({ className = '' }: { className?: string }) => <span className={`hf-workspace-placeholder ${className}`}/>;
const subscribe = () => () => {};
const serverView = (): View => 'Overview';

/** Keep the workspace layout in place while its authenticated request is pending. */
export function WorkspaceSkeleton({ view }: { view: View }) {
  // URL fragments are unavailable on the server. Keep the first hydrated frame
  // identical, then show the requested view's loading layout.
  const loadingView = useSyncExternalStore(subscribe, () => view, serverView);
  return <div className="app-frame hf-workspace-loading" aria-busy="true" aria-label="Loading your workspace">
    <span className="hf-visually-hidden" role="status">Loading your workspace…</span>
    <header className="hf-loading-topbar" aria-hidden="true"><Line className="hf-loading-logo"/><Line className="hf-loading-navigation"/><Line className="hf-loading-account"/></header>
    <aside className="hf-loading-rail" aria-hidden="true">{Array.from({ length: 6 }, (_, index) => <Line key={index}/>)}</aside>
    <main className="main-content hf-loading-content">
      <div className="hf-loading-heading" aria-hidden="true"><div><Line className="hf-loading-eyebrow"/><Line className="hf-loading-title"/><Line className="hf-loading-subtitle"/></div><Line className="hf-loading-button"/></div>
      <div className={`hf-loading-summary ${loadingView === 'Overview' ? 'hf-loading-overview' : ''}`} aria-hidden="true">{Array.from({ length: 3 }, (_, index) => <div className="panel" key={index}><Line className="hf-loading-label"/><Line className="hf-loading-value"/><Line className="hf-loading-note"/>{loadingView === 'Overview' && <Line className="hf-loading-chart"/>}</div>)}</div>
      {loadingView === 'Imports' && <div className="panel hf-loading-upload" aria-hidden="true"><div><Line className="hf-loading-title"/><Line className="hf-loading-subtitle"/></div><Line className="hf-loading-button"/></div>}
      <section className="panel hf-loading-list" aria-label={`Loading ${loadingView === 'Overview' ? 'recent activity' : loadingView.toLowerCase()}`}>
        <div className="hf-loading-toolbar" aria-hidden="true"><Line className="hf-loading-title"/><Line className="hf-loading-filter"/></div>
        <div className="hf-desktop-only"><ListSkeleton count={5} variant="row"/></div>
        <div className="hf-mobile-only"><ListSkeleton count={5} variant="card"/></div>
      </section>
    </main>
  </div>;
}
