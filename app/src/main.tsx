import { Buffer } from 'buffer';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// `@midnight-ntwrk/midnight-js-utils` and the indexer provider reach for the
// Node `Buffer` global — `toHex`/`fromHex` and the Bech32m key parsers are all
// built on it — and a browser has none. Installed before anything imports them
// so the first hex conversion does not throw "Buffer is not defined".
globalThis.Buffer ??= Buffer;

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root container');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
