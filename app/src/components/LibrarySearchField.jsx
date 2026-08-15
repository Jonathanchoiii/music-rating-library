import { memo, useEffect, useRef, useState } from "react";
import { MagnifyingGlass, X } from "@phosphor-icons/react";

function isImeKeyEvent(event) {
  return Boolean(
    event.nativeEvent?.isComposing ||
      event.isComposing ||
      event.keyCode === 229,
  );
}

export const LibrarySearchField = memo(function LibrarySearchField({
  appliedQuery,
  onApply,
  onClear,
}) {
  const inputRef = useRef(null);
  const composingRef = useRef(false);
  const [showClear, setShowClear] = useState(Boolean(appliedQuery));

  function syncClearVisibility() {
    const typed = inputRef.current?.value ?? "";
    setShowClear(Boolean(typed) || Boolean(appliedQuery));
  }

  useEffect(() => {
    if (composingRef.current) return;
    const node = inputRef.current;
    if (node && node.value !== appliedQuery) {
      node.value = appliedQuery;
    }
    setShowClear(Boolean(appliedQuery) || Boolean(node?.value));
  }, [appliedQuery]);

  function applyTypedQuery() {
    onApply(inputRef.current?.value ?? "");
  }

  function handleSubmit(event) {
    event.preventDefault();
    if (composingRef.current) return;
    applyTypedQuery();
  }

  function handleClear() {
    if (inputRef.current) inputRef.current.value = "";
    setShowClear(false);
    onClear();
    inputRef.current?.focus();
  }

  return (
    <form
      className="search-field"
      role="search"
      onSubmit={handleSubmit}
    >
      <button
        type="submit"
        className="search-submit"
        aria-label="搜索"
        title="搜索"
      >
        <MagnifyingGlass aria-hidden="true" />
      </button>
      <label className="sr-only" htmlFor="library-search">
        搜索发行、艺人、流派或评论
      </label>
      <input
        ref={inputRef}
        id="library-search"
        type="search"
        name="library-search"
        defaultValue={appliedQuery}
        placeholder="搜索唱片、艺人或评论"
        autoComplete="off"
        enterKeyHint="search"
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={(event) => {
          const value = event.currentTarget.value;
          window.setTimeout(() => {
            composingRef.current = false;
            if (inputRef.current && inputRef.current.value !== value) {
              return;
            }
            syncClearVisibility();
          }, 0);
        }}
        onInput={syncClearVisibility}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          if (isImeKeyEvent(event) || composingRef.current) {
            event.stopPropagation();
          }
        }}
      />
      {showClear ? (
        <button
          type="button"
          className="search-clear"
          onClick={handleClear}
          aria-label="清除搜索"
        >
          <X aria-hidden="true" />
        </button>
      ) : null}
    </form>
  );
});
