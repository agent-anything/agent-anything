import { useRef, useState, type ReactNode } from "react";
import { Button, Tooltip } from "antd";
import { FullscreenExitOutlined, FullscreenOutlined } from "@ant-design/icons";

export function CanvasFrame({title, children}: {title: string; children: ReactNode}) {
  const [expanded, setExpanded] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return <section className={`canvas-frame${expanded ? " canvas-expanded" : ""}`} aria-label={`${title} canvas`} data-expanded={expanded} onKeyDown={event => {
    // Drawers and menus use portals; their Escape belongs to the overlay.
    if (!expanded || event.defaultPrevented || !event.currentTarget.contains(event.target as Node)) return;
    if (event.key === "Escape") {
      event.stopPropagation();
      setExpanded(false);
      button.current?.focus();
    }
    if (event.key === "Tab") {
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]')]
        .filter(element => element.tabIndex >= 0 && !element.matches(":disabled") && element.checkVisibility());
      const first = controls[0], last = controls.at(-1);
      const target = event.shiftKey && document.activeElement === first ? last : !event.shiftKey && document.activeElement === last ? first : null;
      if (target) {event.preventDefault();target.focus();}
    }
  }}>
    <div className="canvas-heading"><span>{title}</span><Tooltip title={expanded ? "Restore canvas" : "Expand canvas"}>
      <Button ref={button} type="text" size="small" aria-label={`${expanded ? "Restore" : "Expand"} ${title} canvas`} aria-pressed={expanded} icon={expanded ? <FullscreenExitOutlined /> : <FullscreenOutlined />} onClick={() => setExpanded(value => !value)} />
    </Tooltip></div>
    <div className="canvas-body">{children}</div>
  </section>;
}
