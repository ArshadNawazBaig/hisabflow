import { hydrateRoot } from 'react-dom/client';
import { WorkspaceSkeleton } from '../../components/hisab/workspace-skeleton';
import '../../app/globals.css';
import '../../app/typography.css';

declare global { interface Window { __skeletonHydrationErrors: string[] } }
window.__skeletonHydrationErrors = [];
hydrateRoot(document.getElementById('root')!, <WorkspaceSkeleton view={location.hash === '#Imports' ? 'Imports' : 'Overview'}/>, {
  onRecoverableError: error => window.__skeletonHydrationErrors.push(String(error)),
});
