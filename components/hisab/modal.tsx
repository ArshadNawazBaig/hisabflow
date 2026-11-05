'use client';

import { useEffect, useEffectEvent, useRef, type FormHTMLAttributes, type ReactNode, type RefObject } from 'react';
import { X } from 'lucide-react';
import './modal.css';

const activeModals: HTMLElement[] = [];
let backgroundOverflow = '';

type ModalProps = {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  header?: ReactNode;
  onClose: () => void;
  wide?: boolean;
  restoreFocusRef?: RefObject<HTMLElement | null>;
  formProps?: FormHTMLAttributes<HTMLFormElement>;
  className?: string;
};

/** Keep dialog controls visible while the content scrolls within the viewport. */
export function Modal({ title, subtitle, children, footer, header, onClose, wide = false, restoreFocusRef, formProps, className = '' }: ModalProps) {
  const section = useRef<HTMLElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const closeModal = useEffectEvent(onClose);
  useEffect(() => {
    const viewport = window.visualViewport, overlay = backdrop.current;
    if (!viewport || !overlay) return;
    const resize = () => {
      overlay.style.setProperty('--hf-modal-viewport-height', `${viewport.height}px`);
      overlay.style.setProperty('--hf-modal-viewport-top', `${viewport.offsetTop}px`);
      overlay.toggleAttribute('data-compact-viewport', viewport.height <= 450);
    };
    resize();
    viewport.addEventListener('resize', resize);
    viewport.addEventListener('scroll', resize);
    return () => {
      viewport.removeEventListener('resize', resize);
      viewport.removeEventListener('scroll', resize);
    };
  }, []);
  useEffect(() => {
    const modal = section.current;
    if (!modal) return;
    const previous = restoreFocusRef?.current || (document.activeElement as HTMLElement | null);
    if (!activeModals.length) backgroundOverflow = document.body.style.overflow;
    activeModals.push(modal);
    document.body.style.overflow = 'hidden';
    const timer = setTimeout(() => {
      if (activeModals.at(-1) !== modal || modal.contains(document.activeElement)) return;
      const target = modal.querySelector<HTMLElement>('[autofocus]')
        || modal.querySelector<HTMLElement>('input:not([type="hidden"]):not([disabled]):not([tabindex="-1"]), [role="combobox"]:not([disabled]), textarea:not([disabled]), button:not([disabled])');
      target?.focus();
    }, 25);
    const keyboard = (event: KeyboardEvent) => {
      if (activeModals.at(-1) !== modal) return;
      if (event.defaultPrevented || Array.from(document.querySelectorAll<HTMLElement>('[data-hf-popup]')).some(popup => popup.getClientRects().length > 0 && !popup.hasAttribute('data-closed') && popup.dataset.state !== 'closed')) return;
      if (event.key === 'Escape') { event.stopPropagation(); closeModal(); }
      if (event.key !== 'Tab') return;
      const elements = Array.from(section.current?.querySelectorAll<HTMLElement>('button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([type="hidden"]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), a[href]:not([tabindex="-1"])') || []).filter(element => element.offsetParent !== null);
      const first = elements[0], last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keyboard);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('keydown', keyboard);
      const wasTop = activeModals.at(-1) === modal;
      const index = activeModals.indexOf(modal);
      if (index !== -1) activeModals.splice(index, 1);
      if (!activeModals.length) document.body.style.overflow = backgroundOverflow;
      if (wasTop && previous?.isConnected) previous.focus();
    };
  }, [restoreFocusRef]);

  const content = <><div className="hf-modal-body">{children}</div>{footer && <footer className="hf-modal-footer">{footer}</footer>}</>;
  return <div ref={backdrop} className="modal-backdrop rv-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={section} role="dialog" aria-modal="true" aria-label={title} className={`modal rv-modal hf-modal ${wide ? 'rv-modal-wide' : ''} ${className}`}>
      <header className="rv-modal-heading hf-modal-header">
        <div className="hf-modal-header-content">{header ?? <><h2>{title}</h2>{subtitle && <p className="muted">{subtitle}</p>}</>}</div>
        <button type="button" className="rv-icon-button hf-modal-close" aria-label="Close dialog" onClick={onClose}><X size={20}/></button>
      </header>
      {formProps ? <form {...formProps} className={`hf-modal-form ${formProps.className || ''}`}>{content}</form> : content}
    </section>
  </div>;
}
