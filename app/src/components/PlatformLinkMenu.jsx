import { ArrowClockwise, LinkSimple, PencilSimple, Trash } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const LONG_PRESS_DELAY = 480;
const LONG_PRESS_MOVE_TOLERANCE = 12;
export const MOTION_ARTWORK_SLOT = {
  provider: "MOTION_ARTWORK",
  label: "动态封面",
  addLabel: "请求动态封面",
};

function clampMenuPosition(x, y) {
  const width = 240;
  const height = 176;
  const gutter = 12;
  return {
    left: Math.max(gutter, Math.min(x, window.innerWidth - width - gutter)),
    top: Math.max(gutter, Math.min(y, window.innerHeight - height - gutter)),
  };
}

function displayUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`.replace(/\/$/, "");
  } catch {
    return url;
  }
}

export function PlatformLinkMenu({
  menu,
  onClose,
  onEdit,
  onClear,
  onAdd,
  onRefreshMotion,
}) {
  if (!menu || typeof document === "undefined") return null;
  const position = clampMenuPosition(menu.x, menu.y);
  const isMotion = menu.slot?.provider === MOTION_ARTWORK_SLOT.provider;
  const hasLink = Boolean(menu.link?.url);
  return createPortal(
    <div
      className="release-id-menu-backdrop"
      role="presentation"
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => {
        if (event.button === 2) return;
        onClose();
      }}
    >
      <div
        className="release-id-menu platform-link-menu"
        role="menu"
        aria-label={`${menu.slot.label} 操作`}
        style={position}
        onMouseDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="release-id-menu-heading">
          <div>
            <strong>
              {isMotion
                ? "动态封面"
                : menu.slot.addLabel.replace(/^添加 /, "").replace(/链接$/, "").trim()}
            </strong>
            <code>
              {isMotion
                ? hasLink
                  ? "已写入本地动态封面"
                  : "尚未检测"
                : hasLink
                  ? displayUrl(menu.link.url)
                  : "尚未添加链接"}
            </code>
          </div>
        </div>
        {isMotion ? (
          <button
            type="button"
            className="release-id-copy-action"
            role="menuitem"
            autoFocus
            onClick={() => onRefreshMotion?.()}
          >
            <ArrowClockwise aria-hidden="true" />
            重新检测
          </button>
        ) : hasLink ? (
          <>
            <button
              type="button"
              className="release-id-copy-action"
              role="menuitem"
              autoFocus
              onClick={() => onEdit(menu.slot, menu.link)}
            >
              <PencilSimple aria-hidden="true" />
              修改链接
            </button>
            <button
              type="button"
              className="platform-link-menu-clear"
              role="menuitem"
              onClick={() => onClear(menu.slot)}
            >
              <Trash aria-hidden="true" />
              清除链接
            </button>
          </>
        ) : (
          <button
            type="button"
            className="release-id-copy-action"
            role="menuitem"
            autoFocus
            onClick={() => onAdd(menu.slot)}
          >
            <LinkSimple aria-hidden="true" />
            添加链接
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}

export function usePlatformLinkMenu() {
  const [menu, setMenu] = useState(null);
  const timerRef = useRef(null);
  const pressRef = useRef(null);
  const suppressClickProviderRef = useRef("");

  const closeMenu = useCallback(() => {
    setMenu(null);
  }, []);

  function clearLongPress() {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    pressRef.current = null;
  }

  useEffect(() => clearLongPress, []);

  useEffect(() => {
    if (!menu) return undefined;
    function onKeyDown(event) {
      if (event.key === "Escape") closeMenu();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeMenu, menu]);

  function openMenu(slot, link, x, y) {
    setMenu({ slot, link, x, y });
  }

  function bindSlot(slot, link) {
    function openFromEvent(event) {
      event.preventDefault();
      event.stopPropagation();
      clearLongPress();
      openMenu(slot, link, event.clientX, event.clientY);
    }

    return {
      onContextMenu(event) {
        openFromEvent(event);
      },
      onAuxClick(event) {
        if (event.button !== 2) return;
        openFromEvent(event);
      },
      onPointerDown(event) {
        if (event.button === 2) {
          openFromEvent(event);
          return;
        }
        if (event.pointerType !== "touch" || event.button !== 0) return;
        clearLongPress();
        pressRef.current = {
          provider: slot.provider,
          x: event.clientX,
          y: event.clientY,
        };
        timerRef.current = window.setTimeout(() => {
          suppressClickProviderRef.current = slot.provider;
          openMenu(slot, link, event.clientX, event.clientY);
          clearLongPress();
        }, LONG_PRESS_DELAY);
      },
      onPointerMove(event) {
        const press = pressRef.current;
        if (!press || press.provider !== slot.provider) return;
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

  function swallowSuppressedClick(event, provider) {
    if (suppressClickProviderRef.current !== provider) return false;
    suppressClickProviderRef.current = "";
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  return {
    bindSlot,
    swallowSuppressedClick,
    closeMenu,
    menu,
  };
}
