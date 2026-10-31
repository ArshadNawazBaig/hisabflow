'use client';

import { useEffect, useRef, useState, type AriaAttributes } from 'react';
import { Autocomplete } from '@base-ui/react/autocomplete';
import { Check, ChevronDown } from 'lucide-react';
import './combobox.css';

export type AppComboboxProps = Pick<AriaAttributes, 'aria-label' | 'aria-labelledby' | 'aria-describedby'> & {
  options: readonly string[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  name?: string;
  id?: string;
  required?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  className?: string;
};

/** A text field with suggestions. Values do not have to match an option. */
export function AppCombobox({ options, value, defaultValue = '', onValueChange, name, id, required, disabled, autoFocus, placeholder, className = '', ...aria }: AppComboboxProps) {
  const wrapper = useRef<HTMLDivElement>(null);
  const [text, setText] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [portalContainer, setPortalContainer] = useState<HTMLElement>();
  const controlled = value !== undefined;
  const current = controlled ? value : text;
  const hasSuggestions = options.some(option => option.toLocaleLowerCase().includes(current.trim().toLocaleLowerCase()));
  const popupOpen = open && (showAll || hasSuggestions);

  useEffect(() => {
    const form = wrapper.current?.closest('form');
    if (!form) return;
    const reset = () => {
      if (!controlled) setText(defaultValue);
      setOpen(false);
      setShowAll(false);
    };
    form.addEventListener('reset', reset);
    return () => form.removeEventListener('reset', reset);
  }, [controlled, defaultValue]);

  return <div ref={wrapper} className={`hf-combobox ${className}`} onKeyDown={event => {
    if (popupOpen && event.key === 'Escape') event.stopPropagation();
  }}>
    <Autocomplete.Root
      items={options}
      value={current}
      name={name}
      id={id}
      required={required}
      disabled={disabled}
      open={popupOpen}
      openOnInputClick
      autoHighlight={false}
      filter={(option, query) => showAll || option.toLocaleLowerCase().includes(query.toLocaleLowerCase())}
      onValueChange={(next, details) => {
        if (!controlled) setText(next);
        if (details.reason === 'input-change') setShowAll(false);
        onValueChange?.(next);
      }}
      onOpenChange={(next, details) => {
        if (next) {
          setPortalContainer(wrapper.current?.closest<HTMLElement>('.modal, .rv-modal') ?? undefined);
          if (details.reason === 'trigger-press' || details.reason === 'input-press' || details.reason === 'list-navigation') setShowAll(true);
        }
        setOpen(next);
      }}
    >
      <Autocomplete.InputGroup className="hf-combobox-field">
        <Autocomplete.Input className="hf-combobox-input" placeholder={placeholder} autoFocus={autoFocus} autoComplete="off" {...aria}/>
        <Autocomplete.Trigger type="button" className="button hf-combobox-toggle" aria-label="Show account suggestions">
          <ChevronDown size={16} aria-hidden="true"/>
        </Autocomplete.Trigger>
      </Autocomplete.InputGroup>
      <Autocomplete.Portal container={portalContainer}>
        <Autocomplete.Positioner className="hf-combobox-positioner" align="start" sideOffset={6} collisionPadding={10} positionMethod="fixed">
          <Autocomplete.Popup className="hf-combobox-popup" data-hf-popup>
            <Autocomplete.Empty className="hf-combobox-empty">You can use any account name.</Autocomplete.Empty>
            <Autocomplete.List className="hf-combobox-list">
              {(option: string) => <Autocomplete.Item key={option} value={option} className="hf-combobox-option">
                <span>{option}</span>{current === option && <Check size={16} aria-hidden="true"/>}
              </Autocomplete.Item>}
            </Autocomplete.List>
          </Autocomplete.Popup>
        </Autocomplete.Positioner>
      </Autocomplete.Portal>
    </Autocomplete.Root>
  </div>;
}
