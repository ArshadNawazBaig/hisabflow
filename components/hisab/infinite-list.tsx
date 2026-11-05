'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode, type RefCallback } from 'react';
import { ChevronDown } from 'lucide-react';
import './infinite-list.css';

export const INFINITE_BATCH_SIZE = 5;

export type InfiniteListState<T> = {
  visibleItems: T[];
  visibleCount: number;
  totalCount: number;
  hasMore: boolean;
  loading: boolean;
  sentinelRef: RefCallback<HTMLDivElement>;
  loadMore: () => void;
};

function itemIdentity(item: unknown, index: number): string {
  if (item !== null && typeof item === 'object' && 'id' in item) return String(item.id);
  return typeof item === 'string' || typeof item === 'number' ? `${typeof item}:${item}` : `position:${index}`;
}

function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    if (/(auto|scroll|overlay)/.test(getComputedStyle(parent).overflowY)) return parent;
  }
  return null;
}

/** Reveal the already-loaded workspace in five-item render batches. */
export function useInfiniteList<T>(items: T[], resetKey: string): InfiniteListState<T> {
  const ids = items.map(itemIdentity);
  const identity = JSON.stringify(ids);
  const [windowState, setWindowState] = useState(() => ({ resetKey, identity, ids, limit: INFINITE_BATCH_SIZE, generation: 0, loading: false }));
  if (windowState.resetKey !== resetKey || windowState.identity !== identity) {
    const currentIds = new Set(ids);
    const unrelated = windowState.ids.length > 0 && ids.length > 0 && !windowState.ids.some(id => currentIds.has(id));
    const emptied = windowState.ids.length > 0 && ids.length === 0;
    const reset = windowState.resetKey !== resetKey || unrelated || emptied;
    // A filter/source change resets the window before paint. Ordinary object
    // updates and appended/deleted records keep the user's visible coverage.
    setWindowState({ ...windowState, resetKey, identity, ids, limit: reset ? INFINITE_BATCH_SIZE : windowState.limit,
      loading: reset ? false : windowState.loading, generation: windowState.generation + (reset ? 1 : 0) });
  }

  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
  const sentinelRef = useCallback((node: HTMLDivElement | null) => { setSentinel(node); }, []);
  const committed = useRef({ count: items.length, limit: windowState.limit, generation: windowState.generation });
  const pending = useRef(false);
  const frames = useRef<number[]>([]);
  const consumeIntent = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    if (committed.current.generation !== windowState.generation) {
      frames.current.forEach(cancelAnimationFrame); frames.current = []; pending.current = false;
    } else if (committed.current.limit !== windowState.limit && !windowState.loading) {
      pending.current = false;
    }
    committed.current = { count: items.length, limit: windowState.limit, generation: windowState.generation };
  }, [items.length, windowState.limit, windowState.generation, windowState.loading]);
  useEffect(() => () => { frames.current.forEach(cancelAnimationFrame); pending.current = false; }, []);

  const loadMore = useCallback(() => {
    const current = committed.current;
    if (pending.current || current.limit >= current.count) return;
    consumeIntent.current?.();
    pending.current = true;
    const generation = current.generation;
    setWindowState(previous => ({ ...previous, loading: true }));
    // Let the pending skeleton paint before committing the next render batch;
    // no fixed-duration delay or simulated network request is introduced.
    frames.current = [requestAnimationFrame(() => {
      frames.current = [requestAnimationFrame(() => {
        frames.current = [];
        setWindowState(previous => previous.generation === generation
          ? { ...previous, limit: previous.limit + INFINITE_BATCH_SIZE, loading: false } : previous);
      })];
    })];
  }, []);

  const hasItems = items.length > 0;
  useLayoutEffect(() => {
    if (!sentinel) return;
    const root = scrollParent(sentinel), target = root || window;
    let intersecting = false, interactions = 0, consumedInteraction = 0;
    let nativeInputSeen = false;
    let lastScroll = root?.scrollTop ?? window.scrollY;
    let touchY: number | null = null;
    const visible = () => {
      if (!sentinel.getClientRects().length) return false;
      const bounds = sentinel.getBoundingClientRect(), region = root?.getBoundingClientRect();
      return bounds.bottom >= (region?.top ?? 0) && bounds.top <= (region?.bottom ?? window.innerHeight);
    };
    const tryLoad = () => {
      const dialogs = document.querySelectorAll('.hf-modal');
      const topDialog = dialogs.item(dialogs.length - 1);
      if (topDialog && !topDialog.contains(sentinel)) return;
      if (interactions <= consumedInteraction || pending.current || !visible()) return;
      consumedInteraction = interactions;
      loadMore();
    };
    const consume = () => { consumedInteraction = interactions; };
    consumeIntent.current = consume;
    const interact = () => {
      nativeInputSeen = true;
      // Wheel inertia or keys pressed during a pending render must not queue
      // another page. Every new batch needs fresh intent after commit.
      if (pending.current) return;
      interactions++; tryLoad();
    };
    const ownLayer = (event: Event) => event.target instanceof Element && event.target.closest('.hf-modal') === sentinel.closest('.hf-modal');
    const wheel = (event: Event) => { if (ownLayer(event) && (event as WheelEvent).deltaY > 0) interact(); };
    const touchStart = (event: Event) => { touchY = ownLayer(event) ? (event as TouchEvent).touches[0]?.clientY ?? null : null; };
    const touchMove = (event: Event) => { const next = (event as TouchEvent).touches[0]?.clientY ?? null; if (touchY !== null && next !== null && next < touchY) interact(); touchY = next; };
    const scroll = () => {
      const position = root?.scrollTop ?? window.scrollY;
      const downward = position > lastScroll; lastScroll = position;
      if (!downward || pending.current) return;
      // A scrollbar drag or scrollIntoView can enter the sentinel without a
      // wheel event. Layout changes after append must not auto-drain the list.
      if (!nativeInputSeen && (!intersecting || !interactions)) interactions++;
      tryLoad();
    };
    const pointer = (event: Event) => {
      const source = event as PointerEvent;
      const rightEdge = root?.getBoundingClientRect().right ?? window.innerWidth;
      if (source.pointerType === 'mouse' && source.clientX >= rightEdge - 18 && ownLayer(event)) nativeInputSeen = false;
    };
    const key = (event: KeyboardEvent) => {
      const source = event.target as HTMLElement | null;
      if (!['ArrowDown', 'PageDown', 'End', ' '].includes(event.key) || (event.key === ' ' && event.shiftKey) || source?.closest('input,textarea,select,button,a,[contenteditable="true"],[role="combobox"],[role="button"],[role="tab"],[data-hf-popup]')) return;
      if (source?.closest('.hf-modal') !== sentinel.closest('.hf-modal')) return;
      interact();
    };
    target.addEventListener('scroll', scroll, { passive: true });
    target.addEventListener('wheel', wheel, { passive: true });
    target.addEventListener('touchstart', touchStart, { passive: true });
    target.addEventListener('touchmove', touchMove, { passive: true });
    target.addEventListener('pointerdown', pointer, { passive: true });
    document.addEventListener('keydown', key);
    let observer: IntersectionObserver | null = null;
    try {
      if (typeof IntersectionObserver === 'function') {
        observer = new IntersectionObserver(entries => {
          intersecting = entries.some(entry => entry.isIntersecting);
          if (intersecting) tryLoad();
        }, { root, rootMargin: '0px', threshold: 0 });
        observer.observe(sentinel);
      }
    } catch { observer?.disconnect(); observer = null; }
    return () => {
      observer?.disconnect();
      if (consumeIntent.current === consume) consumeIntent.current = null;
      target.removeEventListener('scroll', scroll);
      target.removeEventListener('wheel', wheel);
      target.removeEventListener('touchstart', touchStart);
      target.removeEventListener('touchmove', touchMove);
      target.removeEventListener('pointerdown', pointer);
      document.removeEventListener('keydown', key);
    };
  }, [sentinel, windowState.generation, hasItems, loadMore]);

  const visibleCount = Math.min(windowState.limit, items.length);
  const hasMore = visibleCount < items.length;
  return { visibleItems: items.slice(0, visibleCount), visibleCount, totalCount: items.length,
    hasMore, loading: windowState.loading && hasMore, sentinelRef, loadMore };
}

export function Skeleton({ className = '', ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span {...props} className={`hf-skeleton ${className}`} aria-hidden="true"/>;
}

export function ListSkeleton({ count = INFINITE_BATCH_SIZE, variant = 'card' }: { count?: number; variant?: 'card' | 'row' }) {
  return <div className={`hf-list-skeleton hf-list-skeleton-${variant}`} aria-hidden="true" data-hf-skeleton="list" data-testid="list-skeleton">
    {Array.from({ length: Math.max(0, Math.min(50, Math.floor(count))) }, (_, index) => <div className="hf-list-skeleton-item" data-testid="skeleton-item" key={index}>
      <Skeleton className="hf-skeleton-avatar"/><div className="hf-list-skeleton-copy"><Skeleton className="hf-skeleton-title"/><Skeleton className="hf-skeleton-description"/></div>
      <Skeleton className="hf-skeleton-value"/>{variant === 'card' && <div className="hf-list-skeleton-meta"><Skeleton/><Skeleton/></div>}
    </div>)}
  </div>;
}

export function InfiniteListFooter<T>({ list, label, skeleton }: { list: InfiniteListState<T>; label: string; skeleton?: ReactNode }) {
  const { totalCount, visibleCount, loading, hasMore, sentinelRef, loadMore } = list;
  if (!totalCount) return null;
  const nextCount = Math.min(INFINITE_BATCH_SIZE, totalCount - visibleCount);
  return <div className="hf-infinite-footer" aria-busy={loading || undefined} data-testid="infinite-footer">
    <div ref={sentinelRef} className="hf-infinite-sentinel" aria-hidden="true" data-testid="infinite-sentinel"/>
    <div className="hf-infinite-progress">
      <span role="status" aria-live="polite" aria-atomic="true">{loading ? `Loading ${nextCount} more ${label}…`
        : hasMore ? `Showing ${visibleCount} of ${totalCount} ${label}` : `All ${totalCount} ${label} loaded`}</span>
      {hasMore && <button type="button" className="button button-secondary hf-load-more" disabled={loading} onClick={loadMore}
        aria-label={`Load more ${label}`}>{loading ? 'Loading…' : `Load ${nextCount} more`}<ChevronDown size={15}/></button>}
    </div>
    {loading && (skeleton ?? <><div className="hf-desktop-only"><ListSkeleton count={nextCount} variant="row"/></div><div className="hf-mobile-only"><ListSkeleton count={nextCount} variant="card"/></div></>)}
  </div>;
}
