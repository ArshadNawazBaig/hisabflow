// Isolated browser entry point. Never included in the application or its routes.
import { createRoot } from 'react-dom/client';
import HisabApp from '../../components/hisab/hisab-app';
import '../../app/globals.css';
import '../../app/typography.css';

createRoot(document.getElementById('root')!).render(<HisabApp/>);
