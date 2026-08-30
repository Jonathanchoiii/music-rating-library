import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowClockwise,
  Compass,
  Disc,
  GlobeHemisphereWest,
  MapPin,
  UsersThree,
} from "@phosphor-icons/react";
import { Link, useNavigate } from "react-router-dom";
import { ROAM_REGIONS, getRoamRegionsByContinent } from "../lib/roam.js";
import { Cover } from "./ReleaseViews.jsx";
import { Rating } from "./Rating.jsx";
import { RoamGlobe } from "./RoamGlobe.jsx";

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "long",
  day: "numeric",
});

function formatDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? dateFormatter.format(date) : "";
}

function RoamStat({ value, label }) {
  return (
    <div className="roam-stat">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function CountryFlag({ code, name }) {
  const [failed, setFailed] = useState(false);
  const normalizedCode = String(code || "").trim().toLowerCase();

  return (
    <span className={`roam-country-flag${failed ? " is-fallback" : ""}`} aria-hidden="true">
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

function CountryCard({ region }) {
  const content = (
    <>
      <CountryFlag code={region.code} name={region.name} />
      <div>
        <strong>{region.name}</strong>
        <span>{region.englishName}</span>
      </div>
      {region.lit ? (
        <span className="roam-country-status">
          已点亮 <ArrowRight weight="bold" />
        </span>
      ) : (
        <span className="roam-country-status">待探索</span>
      )}
    </>
  );
  return region.lit ? (
    <Link className="roam-country-card is-lit" to={`/roam/${region.code.toLowerCase()}`}>
      {content}
    </Link>
  ) : (
    <article className="roam-country-card" aria-label={`${region.name}尚未点亮`}>
      {content}
    </article>
  );
}

function RoamRefreshControl({ refreshing, onRefresh, refreshHref }) {
  const label = refreshing ? "正在核验新的艺人国家资料" : "刷新艺人国家资料";
  const content = <ArrowClockwise weight="bold" aria-hidden="true" />;
  if (refreshHref && !onRefresh) {
    return (
      <a className="roam-country-refresh" href={refreshHref} aria-label={label} title={label}>
        {content}
      </a>
    );
  }
  if (!onRefresh) return null;
  return (
    <button
      className={`roam-country-refresh${refreshing ? " is-refreshing" : ""}`}
      type="button"
      onClick={onRefresh}
      disabled={refreshing}
      aria-label={label}
      title={label}
    >
      {content}
    </button>
  );
}

function RoamIndex({ model, onSelectCountry, onRefreshCountries, refreshHref, refreshing }) {
  const [scope, setScope] = useState("lit");
  const [continentId, setContinentId] = useState("ALL");
  const continents = useMemo(
    () => getRoamRegionsByContinent(model.litCodes, scope === "lit"),
    [model.litCodes, scope],
  );
  const visibleContinents =
    continentId === "ALL"
      ? continents
      : continents.filter((continent) => continent.id === continentId);

  return (
    <div className="roam-page">
      <section className="roam-intro">
        <div className="roam-intro-copy">
          <p className="roam-kicker"><Compass weight="fill" /> 你的听歌护照</p>
          <h1>漫游</h1>
          <p>一张由真实聆听记录点亮的世界地图。只有资料来源明确、国家或地区能够唯一确认的艺人才会被计入。</p>
          <div className="roam-intro-stats">
            <RoamStat value={model.stats.countryCount} label="已点亮地区" />
            <RoamStat value={model.stats.continentCount} label="已到访大洲" />
            <RoamStat value={model.stats.artistCount} label="确认艺人" />
            <RoamStat value={model.stats.releaseCount} label="听过唱片" />
          </div>
        </div>
        <RoamGlobe countries={model.countries} onSelectCountry={onSelectCountry} />
      </section>

      <section className="roam-directory" aria-labelledby="roam-directory-title">
        <header className="roam-section-heading">
          <div>
            <p className="eyebrow">Listening atlas</p>
            <div className="roam-directory-title-row">
              <h2 id="roam-directory-title">我的音乐版图</h2>
              <RoamRefreshControl
                refreshing={refreshing}
                onRefresh={onRefreshCountries}
                refreshHref={refreshHref}
              />
            </div>
          </div>
          <div className="roam-scope-switch" aria-label="地区状态">
            <button className={scope === "lit" ? "is-active" : ""} type="button" onClick={() => setScope("lit")}>已点亮</button>
            <button className={scope === "all" ? "is-active" : ""} type="button" onClick={() => setScope("all")}>全部地区</button>
          </div>
        </header>

        <div className="roam-continent-tabs" aria-label="按大洲筛选">
          <button type="button" className={continentId === "ALL" ? "is-active" : ""} onClick={() => setContinentId("ALL")}>全部</button>
          {continents.map((continent) => (
            <button key={continent.id} type="button" className={continentId === continent.id ? "is-active" : ""} onClick={() => setContinentId(continent.id)}>
              {continent.name}<span>{continent.regions.filter((region) => region.lit).length}</span>
            </button>
          ))}
        </div>

        {visibleContinents.length ? (
          <div className="roam-continent-sections">
            {visibleContinents.map((continent) => (
              <section className="roam-continent-section" key={continent.id}>
                <header>
                  <div>
                    <h3>{continent.name}</h3>
                    <p>{continent.englishName}</p>
                  </div>
                  <strong>{continent.regions.filter((region) => region.lit).length} 个已点亮</strong>
                </header>
                <div className="roam-country-grid">
                  {continent.regions.map((region) => <CountryCard key={region.code} region={region} />)}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div className="roam-empty">
            <GlobeHemisphereWest />
            <h3>世界还在等待第一束光</h3>
            <p>先为一位听过的艺人生成可信艺人介绍；当国家或地区被明确核验后，这里会自动点亮。</p>
            <Link className="primary-button" to="/artists">去艺人页看看</Link>
          </div>
        )}
      </section>
    </div>
  );
}

function ArtistBlock({ artist, countryCode, onOpenRelease, onOpenArtist }) {
  return (
    <section className="roam-artist-block">
      <header>
        <button type="button" className="roam-artist-identity" onClick={() => onOpenArtist(artist.id)}>
          {artist.imageUrl ? <img src={artist.imageUrl} alt="" /> : <span><UsersThree /></span>}
          <span>
            <strong>{artist.name}</strong>
            <small>{artist.releases.length} 张听过的唱片 · 平均 {artist.average.toFixed(1)}</small>
          </span>
        </button>
        <button className="roam-artist-link" type="button" onClick={() => onOpenArtist(artist.id)}>
          查看艺人 <ArrowRight />
        </button>
      </header>
      <div className="roam-album-grid">
        {artist.releases.map(({ release, rating }) => (
          <article className="roam-album-card" key={release.id}>
            <button type="button" onClick={() => onOpenRelease(release.id, countryCode)} aria-label={`打开《${release.title}》`}>
              <Cover release={release} />
            </button>
            <div>
              <button type="button" onClick={() => onOpenRelease(release.id, countryCode)}>{release.title}</button>
              <Rating score={rating} compact />
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function CountryDetail({ model, countryCode, onOpenRelease, onOpenArtist }) {
  const catalogRegion = ROAM_REGIONS.find((region) => region.code === countryCode);
  const country = model.countryByCode[countryCode];

  if (!country) {
    return (
      <div className="roam-page roam-country-page">
        <Link className="roam-back" to="/roam"><ArrowLeft /> 返回漫游</Link>
        <section className="roam-locked-country">
          <GlobeHemisphereWest />
          <span>{catalogRegion?.code ?? countryCode}</span>
          <h1>{catalogRegion?.name ?? "未知地区"}尚未点亮</h1>
          <p>目前没有同时满足“你已评分听过”与“艺人地区有可信来源”两项条件的艺人记录。</p>
          <Link className="primary-button" to="/artists">前往艺人资料</Link>
        </section>
      </div>
    );
  }

  return (
    <div className="roam-page roam-country-page">
      <Link className="roam-back" to="/roam"><ArrowLeft /> 返回漫游</Link>
      <section className="roam-country-hero">
        <RoamGlobe countries={[country]} compact />
        <div className="roam-country-copy">
          <p className="roam-kicker"><MapPin weight="fill" /> {country.continentName}</p>
          <h1>{country.name}</h1>
          <p>{country.englishName}</p>
          {country.firstListenedAt ? <small>首次点亮于 {formatDate(country.firstListenedAt)}</small> : null}
          <div className="roam-country-stats">
            <RoamStat value={country.artists.length} label="艺人" />
            <RoamStat value={country.releases.length} label="听过唱片" />
            <RoamStat value={country.average.toFixed(1)} label="平均评分" />
          </div>
        </div>
      </section>

      <section className="roam-country-list">
        <header className="roam-section-heading">
          <div>
            <p className="eyebrow">Artists & records</p>
            <h2>来自{country.name}的声音</h2>
          </div>
          <span><Disc weight="fill" /> {country.releases.length} 张唱片</span>
        </header>
        {country.artists.map((artist) => (
          <ArtistBlock key={artist.id} artist={artist} countryCode={country.code} onOpenRelease={onOpenRelease} onOpenArtist={onOpenArtist} />
        ))}
      </section>
    </div>
  );
}

export function RoamPage({
  model,
  selectedCountryCode,
  onOpenRelease,
  onOpenArtist,
  onRefreshCountries,
  refreshCountriesHref,
  refreshingCountries = false,
}) {
  const navigate = useNavigate();
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [selectedCountryCode]);

  return selectedCountryCode ? (
    <CountryDetail model={model} countryCode={selectedCountryCode} onOpenRelease={onOpenRelease} onOpenArtist={onOpenArtist} />
  ) : (
    <RoamIndex
      model={model}
      onSelectCountry={(countryCode) => navigate(`/roam/${countryCode.toLowerCase()}`)}
      onRefreshCountries={onRefreshCountries}
      refreshHref={refreshCountriesHref}
      refreshing={refreshingCountries}
    />
  );
}
