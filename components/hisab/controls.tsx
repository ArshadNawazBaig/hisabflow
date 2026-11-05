'use client';

import { useEffect, useId, useRef, useState, type AriaAttributes, type ReactNode, type RefObject } from 'react';
import { Select } from '@base-ui/react/select';
import { Popover } from '@base-ui/react/popover';
import { DayPicker } from 'react-day-picker';
import { CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { formatISODate, isDateAllowed, parseISODate } from '@/lib/control-dates';
import { today as businessToday } from '@/lib/types';
import './controls.css';

type AccessibleControlProps = Pick<AriaAttributes, 'aria-label' | 'aria-labelledby' | 'aria-describedby' | 'aria-invalid'> & {
  id?: string;
  name?: string;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  size?: 'field' | 'compact';
};
export type AppSelectOption = { value: string; label: ReactNode; disabled?: boolean };
export type AppSelectProps = AccessibleControlProps & {
  options: AppSelectOption[];
  leadingIcon?: ReactNode;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
};
export type AppDatePickerProps = AccessibleControlProps & {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  min?: string;
  max?: string;
  placeholder?: string;
};

function popupParent(element: HTMLElement | null): HTMLElement | undefined {
  return element?.closest<HTMLElement>('[data-hf-popup], .modal, .rv-modal') || undefined;
}

function useControlValue(value: string | undefined, initialValue: string, root: RefObject<HTMLElement | null>, onValueChange?: (value: string) => void) {
  const firstValue = useRef(initialValue);
  const [internalValue, setInternalValue] = useState(initialValue);
  const controlled = value !== undefined;
  useEffect(() => {
    if (controlled) return;
    const form = root.current?.closest('form');
    const reset = () => queueMicrotask(() => setInternalValue(firstValue.current));
    form?.addEventListener('reset', reset);
    return () => form?.removeEventListener('reset', reset);
  }, [controlled, root]);
  return [controlled ? value : internalValue, (next: string) => {
    if (!controlled) setInternalValue(next);
    onValueChange?.(next);
  }] as const;
}

/** One branded, keyboard-accessible select for fields and compact filters. */
export function AppSelect({ options, leadingIcon, value, defaultValue, onValueChange, placeholder = 'Choose an option', id, name, required, disabled, className = '', size = 'field', ...aria }: AppSelectProps) {
  const generatedId = useId();
  const controlId = id || `hf-select-${generatedId}`;
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [current, change] = useControlValue(value, defaultValue ?? options[0]?.value ?? '', rootRef, onValueChange);
  const [invalid, setInvalid] = useState(false);
  const [container, setContainer] = useState<HTMLElement>();
  const selected = options.find(option => option.value === current);
  const errorId = `${controlId}-error`;
  const showInvalid=invalid&&!current;
  const description = [aria['aria-describedby'], showInvalid ? errorId : undefined].filter(Boolean).join(' ') || undefined;
  useEffect(() => {
    const form = rootRef.current?.closest('form');
    const reset = () => setInvalid(false);
    form?.addEventListener('reset', reset);
    return () => form?.removeEventListener('reset', reset);
  }, []);

  return <span ref={rootRef} className={`hf-control hf-select hf-control-${size}`} onInvalidCapture={event => {
    event.preventDefault(); setInvalid(true); triggerRef.current?.focus();
  }}>
    <Select.Root<string> id={controlId} name={name} required={required} disabled={disabled} value={current} items={options} modal={false}
      onOpenChange={open => { if (open) setContainer(popupParent(rootRef.current)); }}
      onValueChange={next => { change(next ?? ''); setInvalid(false); }}>
      <Select.Trigger ref={triggerRef} id={controlId} type="button" className={`button hf-control-trigger hf-select-trigger ${className}`} {...aria} aria-describedby={description} aria-invalid={showInvalid || aria['aria-invalid'] || undefined} aria-required={required || undefined} data-empty={!current || undefined}>
        {leadingIcon && <span className="hf-control-leading" aria-hidden="true">{leadingIcon}</span>}
        <Select.Value className="hf-control-value">{selected?.label ?? placeholder}</Select.Value>
        <Select.Icon className="hf-control-icon"><ChevronDown size={16}/></Select.Icon>
      </Select.Trigger>
      <Select.Portal container={container}>
        <Select.Positioner sideOffset={6} align="start" alignItemWithTrigger={false} positionMethod="fixed" collisionPadding={10} className="hf-select-positioner">
          <Select.Popup data-hf-popup="select" className="hf-select-popup" finalFocus={triggerRef} onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation(); }}>
            <Select.List className="hf-select-list">
              {options.map(option => <Select.Item key={option.value} value={option.value} disabled={option.disabled} className="hf-select-option" label={typeof option.label === 'string' ? option.label : undefined}>
                <Select.ItemText className="hf-option-label">{option.label}</Select.ItemText>
                <Select.ItemIndicator className="hf-option-check"><Check size={16}/></Select.ItemIndicator>
              </Select.Item>)}
              {!options.length && <span className="hf-options-empty">No options available</span>}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
    {showInvalid && <span id={errorId} className="hf-control-error" role="alert">Choose an option to continue.</span>}
  </span>;
}

const monthLabels = Array.from({ length: 12 }, (_, month) => new Intl.DateTimeFormat('en', { month: 'long' }).format(new Date(2020, month, 15)));
const displayDate = (date: Date) => new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).format(date);
const firstOfMonth = (date: Date) => { const copy = new Date(date); copy.setDate(1); return copy; };
const shiftMonth = (date: Date, by: number) => { const copy = firstOfMonth(date); copy.setMonth(copy.getMonth() + by); return copy; };

/** Date-only picker with the same field chrome, custom month/year menus and ISO form values. */
export function AppDatePicker({ value, defaultValue = '', onValueChange, id, name, required, disabled, className = '', size = 'field', min, max, placeholder = 'Choose a date', ...aria }: AppDatePickerProps) {
  const generatedId = useId();
  const controlId = id || `hf-date-${generatedId}`;
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [current, change] = useControlValue(value, defaultValue, rootRef, onValueChange);
  const selected = parseISODate(current);
  const today = parseISODate(businessToday())!;
  const lower = parseISODate(min), upper = parseISODate(max);
  const [month, setMonth] = useState(() => firstOfMonth(selected || lower || today));
  const [open, setOpen] = useState(false);
  const [container, setContainer] = useState<HTMLElement>();
  const [invalid, setInvalid] = useState(false);
  const errorId = `${controlId}-error`;
  const showInvalid=invalid&&(!current||!isDateAllowed(current,min,max));
  const description = [aria['aria-describedby'], showInvalid ? errorId : undefined].filter(Boolean).join(' ') || undefined;
  const startYear = lower?.getFullYear() ?? Math.max(1, Math.min(1900, selected?.getFullYear() ?? upper?.getFullYear() ?? 1900));
  const endYear = upper?.getFullYear() ?? Math.min(9999, Math.max(today.getFullYear() + 20, startYear + 20, selected?.getFullYear() ?? 0));
  const calendarStart = parseISODate(`${String(startYear).padStart(4, '0')}-01-01`)!;
  const calendarEnd = parseISODate(`${String(endYear).padStart(4, '0')}-12-31`)!;
  const years = Array.from({ length: Math.max(0, endYear - startYear + 1) }, (_, index) => ({ value: String(startYear + index), label: String(startYear + index) }));
  const monthOptions = monthLabels.map((label, index) => ({ value: String(index), label, disabled: !!(lower && month.getFullYear() === lower.getFullYear() && index < lower.getMonth() || upper && month.getFullYear() === upper.getFullYear() && index > upper.getMonth()) }));
  const dateAllowed = (date: Date) => isDateAllowed(formatISODate(date), min, max);
  const previousDisabled = shiftMonth(month, -1) < firstOfMonth(lower || calendarStart);
  const nextDisabled = shiftMonth(month, 1) > firstOfMonth(upper || calendarEnd);
  const setVisibleMonth = (next: Date) => {
    if (next < firstOfMonth(lower || calendarStart)) next = firstOfMonth(lower || calendarStart);
    if (next > firstOfMonth(upper || calendarEnd)) next = firstOfMonth(upper || calendarEnd);
    setMonth(firstOfMonth(next));
  };
  const choose = (date: Date | undefined) => {
    const next = date ? formatISODate(date) : '';
    if (next && !isDateAllowed(next, min, max)) return;
    change(next); setInvalid(false); setOpen(false);
  };
  useEffect(() => {
    const invalidDate = !!current && !isDateAllowed(current, min, max);
    inputRef.current?.setCustomValidity(invalidDate ? 'Choose a valid date within the allowed range.' : '');
  }, [current, min, max]);
  useEffect(() => {
    const form = rootRef.current?.closest('form');
    const reset = () => { setInvalid(false); setOpen(false); };
    form?.addEventListener('reset', reset);
    return () => form?.removeEventListener('reset', reset);
  }, []);

  return <span ref={rootRef} className={`hf-control hf-datepicker hf-control-${size}`}>
    <Popover.Root open={open} modal="trap-focus" onOpenChange={next => {
      if (disabled) return;
      if (next) { setContainer(popupParent(rootRef.current)); setVisibleMonth(selected || today); }
      setOpen(next);
    }}>
      <Popover.Trigger ref={triggerRef} id={controlId} type="button" disabled={disabled} className={`button hf-control-trigger hf-date-trigger ${className}`} {...aria} aria-describedby={description} aria-invalid={showInvalid || aria['aria-invalid'] || undefined} aria-required={required || undefined} data-empty={!selected || undefined}>
        <CalendarDays size={17} className="hf-date-leading"/><span className="hf-control-value">{selected ? displayDate(selected) : current || placeholder}</span><ChevronDown size={15} className="hf-control-icon"/>
      </Popover.Trigger>
      <Popover.Portal container={container}>
        <Popover.Positioner sideOffset={7} align="start" positionMethod="fixed" sticky collisionPadding={10} className="hf-date-positioner">
          <Popover.Popup ref={popupRef} data-hf-popup="date" className="hf-calendar-popup" finalFocus={triggerRef} initialFocus={() => popupRef.current?.querySelector<HTMLElement>('[role="grid"] button[tabindex="0"]') || true} onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation(); }}>
            <Popover.Title className="hf-visually-hidden">Choose a date</Popover.Title>
            <div className="hf-calendar-heading">
              <button type="button" className="button hf-calendar-nav" aria-label="Previous month" disabled={previousDisabled} onClick={() => setVisibleMonth(shiftMonth(month, -1))}><ChevronLeft size={18}/></button>
              <div className="hf-calendar-month-year">
                <AppSelect aria-label="Choose month" size="compact" value={String(month.getMonth())} options={monthOptions} onValueChange={next => { const date = new Date(month); date.setMonth(Number(next)); setVisibleMonth(date); }}/>
                <AppSelect aria-label="Choose year" size="compact" value={String(month.getFullYear())} options={years} onValueChange={next => { const date = new Date(month); date.setFullYear(Number(next)); setVisibleMonth(date); }}/>
              </div>
              <button type="button" className="button hf-calendar-nav" aria-label="Next month" disabled={nextDisabled} onClick={() => setVisibleMonth(shiftMonth(month, 1))}><ChevronRight size={18}/></button>
            </div>
            <DayPicker mode="single" required selected={selected} onSelect={choose} month={month} onMonthChange={setVisibleMonth} today={today} hideNavigation showOutsideDays fixedWeeks autoFocus weekStartsOn={1}
              startMonth={firstOfMonth(lower || calendarStart)} endMonth={firstOfMonth(upper || calendarEnd)}
              disabled={[...(lower ? [{ before: lower }] : []), ...(upper ? [{ after: upper }] : [])]}
              className="hf-calendar" components={{ MonthCaption: () => <></> }}
              classNames={{ months: 'hf-calendar-months', month: 'hf-calendar-month', month_grid: 'hf-calendar-grid', weekdays: 'hf-calendar-weekdays', weekday: 'hf-calendar-weekday', week: 'hf-calendar-week', day: 'hf-calendar-day', day_button: 'hf-calendar-day-button', selected: 'hf-calendar-selected', today: 'hf-calendar-today', outside: 'hf-calendar-outside', disabled: 'hf-calendar-disabled', hidden: 'hf-calendar-hidden' }}/>
            <div className="hf-calendar-footer"><button type="button" className="button hf-calendar-today-action" disabled={!dateAllowed(today)} onClick={() => choose(today)}>Today</button><button type="button" className="button hf-calendar-clear" disabled={!current} onClick={() => choose(undefined)}>Clear date</button><Popover.Close className="button hf-calendar-dismiss" aria-label="Close calendar">Done</Popover.Close></div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
    <input ref={inputRef} className="hf-form-value" name={name} type="text" value={current} required={required} disabled={disabled} tabIndex={-1} aria-hidden="true" autoComplete="off"
      onChange={event => { if (isDateAllowed(event.currentTarget.value, min, max) || !event.currentTarget.value) change(event.currentTarget.value); }}
      onFocus={() => triggerRef.current?.focus()}
      onInvalid={event => { event.preventDefault(); setInvalid(true); triggerRef.current?.focus(); }}/>
    {showInvalid && <span id={errorId} className="hf-control-error" role="alert">{current ? 'Choose a valid date within the allowed range.' : 'Choose a date to continue.'}</span>}
  </span>;
}
