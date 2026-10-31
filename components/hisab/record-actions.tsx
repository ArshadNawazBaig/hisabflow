'use client';

import { Menu } from '@base-ui/react/menu';
import { useRef } from 'react';
import { Eye, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import './record-actions.css';

/** Shared row actions, kept outside the table's scroll container. */
export function RecordActions({ name, onView, onEdit, onDelete }: {
  name: string;
  onView: (trigger: HTMLButtonElement | null) => void;
  onEdit: (trigger: HTMLButtonElement | null) => void;
  onDelete: (trigger: HTMLButtonElement | null) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const run = (action: (trigger: HTMLButtonElement | null) => void) => {
    trigger.current?.focus();
    action(trigger.current);
  };
  return <Menu.Root modal={false}>
    <Menu.Trigger ref={trigger} type="button" className="hf-record-actions-trigger" aria-label={`Actions for ${name}`}>
      <MoreHorizontal size={20}/>
    </Menu.Trigger>
    <Menu.Portal>
      <Menu.Positioner positionMethod="fixed" sideOffset={6} align="end" collisionPadding={10} className="hf-record-actions-positioner">
        <Menu.Popup data-hf-popup="actions" className="hf-record-actions-menu" aria-label={`Actions for ${name}`}>
          <Menu.Item className="hf-record-action" onClick={()=>run(onView)}><Eye size={17}/>View</Menu.Item>
          <Menu.Item className="hf-record-action" onClick={()=>run(onEdit)}><Pencil size={17}/>Edit</Menu.Item>
          <Menu.Item className="hf-record-action hf-record-action-delete" onClick={()=>run(onDelete)}><Trash2 size={17}/>Delete</Menu.Item>
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  </Menu.Root>;
}
