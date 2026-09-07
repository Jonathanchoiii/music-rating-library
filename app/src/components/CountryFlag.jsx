import { useState } from "react";

export function CountryFlag({ code, name, variant = "card" }) {
  const [failed, setFailed] = useState(false);
  const normalizedCode = String(code || "").trim().toLowerCase();

  return (
    <span
      className={`roam-country-flag is-${variant}${failed ? " is-fallback" : ""}`}
      aria-hidden="true"
    >
      {failed || !normalizedCode ? (
        <span>{code}</span>
      ) : (
        <img
          src={`https://flagcdn.io/flags/4x3/${normalizedCode}.svg`}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          title={`${name}国旗`}
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}
