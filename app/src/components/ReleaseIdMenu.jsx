import { CopySimple } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";

const LONG_PRESS_DELAY = 560;
const LONG_PRESS_MOVE_TOLERANCE = 12;

function clampMenuPosition(x, y) {
  const width = 286;
  const height = 132;
  const gutter = 12;
  return {
    left: Math.max(gutter, Math.min(x, window.innerWidth - width - gutter)),
    top: Math.max(gutter, Math.min(y, window.innerHeight - height - gutter)),
  };
}

export function ReleaseIdMenu({ menu, onClose, onCopy }) {
  if (!menu) return null;
  const position = clampMenuPosition(menu.x, menu.y);
  return (
    <div
      className="release-id-menu-backdrop"
      role="presentation"
      onPointerDown={onClose}
    >
      <div
        className="release-id-menu"
        role="menu"
        aria-label={`${menu.release.title} 操作`}
        style={position}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="release-id-menu-heading">
          <div>
            <strong>{menu.release.title}</strong>
            <code>{menu.release.id}</code>
          </div>
        </div>
        <button
          type="button"
          className="release-id-copy-action"
          role="menuitem"
          autoFocus
          onClick={() => onCopy(menu.release)}
        >
          <CopySimple aria-hidden="true" />
          复制专辑 ID
        </button>
      </div>
    </div>
  );
}

export function useReleaseIdMenu(onCopyReleaseId) {
  const [menu, setMenu] = useState(null);
  const timerRef = useRef(null);
  const pressRef = useRef(null);
  const suppressClickReleaseIdRef = useRef("");

  function clearLongPress() {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    pressRef.current = null;
  }

  useEffect(() => clearLongPress, []);

  useEffect(() => {
    if (!menu) return undefined;
    function onKeyDown(event) {
      if (event.key === "Escape") setMenu(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menu]);

  function openMenu(release, x, y) {
    setMenu({ release, x, y });
  }

  function bindRelease(release) {
    return {
      onContextMenu(event) {
        event.preventDefault();
        event.stopPropagation();
        clearLongPress();
        openMenu(release, event.clientX, event.clientY);
      },
      onPointerDown(event) {
        if (event.pointerType !== "touch" || event.button !== 0) return;
        clearLongPress();
        pressRef.current = {
          releaseId: release.id,
          x: event.clientX,
          y: event.clientY,
        };
        timerRef.current = window.setTimeout(() => {
          suppressClickReleaseIdRef.current = release.id;
          openMenu(release, event.clientX, event.clientY);
          clearLongPress();
        }, LONG_PRESS_DELAY);
      },
      onPointerMove(event) {
        const press = pressRef.current;
        if (!press || press.releaseId !== release.id) return;
        if (
          Math.abs(event.clientX - press.x) > LONG_PRESS_MOVE_TOLERANCE ||
          Math.abs(event.clientY - press.y) > LONG_PRESS_MOVE_TOLERANCE
        ) {
          clearLongPress();
        }
      },
      onPointerUp: clearLongPress,
      onPointerCancel: clearLongPress,
    };
  }

  function activateRelease(event, release, onOpen) {
    if (suppressClickReleaseIdRef.current === release.id) {
      suppressClickReleaseIdRef.current = "";
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onOpen(release.id);
  }

  async function copyReleaseId(release) {
    await onCopyReleaseId?.(release.id, release.title);
    setMenu(null);
  }

  return {
    bindRelease,
    activateRelease,
    menuElement: (
      <ReleaseIdMenu
        menu={menu}
        onClose={() => setMenu(null)}
        onCopy={copyReleaseId}
      />
    ),
  };
}
