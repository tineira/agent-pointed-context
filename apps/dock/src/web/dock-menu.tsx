/**
 * The dock footer's "⋯" menu (TIN-702): what the dock needs now and then (Try your dock, the
 * downloads, Start over), kept out of the way. A button with a popover menu: arrows, Home and End
 * move between items, Escape closes it and gives focus back to the button, Tab or a click outside
 * closes it, and choosing an item closes it. Focus goes back to the button before an item acts, so a
 * dialog an item opens (Start over) returns focus there, and an item may move it on (Try your dock).
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { MoreIcon } from "./icons.tsx";

export function DockMenu(props: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const items = () => [...(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];

  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const outside = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      button.current?.focus();
      return;
    }
    if (e.key === "Tab") {
      // From the button, so Tab and Shift+Tab go on from where the menu was opened.
      button.current?.focus();
      return setOpen(false);
    }
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "ArrowDown" ? (at + 1) % all.length : e.key === "ArrowUp" ? (at - 1 + all.length) % all.length : e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    all[next]?.focus();
  };

  return (
    <div className="dock-menu" ref={wrap}>
      <button
        ref={button}
        type="button"
        className="icon-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? "dock-menu-list" : undefined}
        title="More: try your dock, downloads, start over"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          setOpen(true);
        }}
      >
        <MoreIcon />
        <span className="icon-label">More</span>
      </button>
      {open && (
        <div
          id="dock-menu-list"
          ref={list}
          role="menu"
          aria-label="More"
          className="dock-menu-list"
          onKeyDown={onKey}
          onClickCapture={(e) => {
            if ((e.target as HTMLElement).closest('[role="menuitem"]')) button.current?.focus();
          }}
          onClick={(e) => {
            if ((e.target as HTMLElement).closest('[role="menuitem"]')) setOpen(false);
          }}
        >
          {props.children}
        </div>
      )}
    </div>
  );
}
