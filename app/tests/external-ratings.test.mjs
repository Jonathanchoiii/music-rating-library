import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeExternalRatingLinks,
  parseAotyMusicRating,
  parseDoubanMusicRating,
  parseMetacriticMusicRating,
  parseRecordClubRating,
  refreshExternalRatings,
} from "../external-ratings/index.mjs";
import { getReleaseMetadataFields } from "../src/lib/neodbSync.js";

const DOUBAN_HTML = `
  <meta property="og:title" content="安和桥北" />
  <meta property="music:musician" content="宋冬野" />
  <span class="pl">发行时间:</span>&nbsp;2013-08-26<br />
  <strong class="ll rating_num" property="v:average">8.9</strong>
  <span property="v:votes">56,775</span>人评价
`;

const METACRITIC_HTML = `
  <meta property="og:title" content="Renaissance Reviews and Tracks - Metacritic" />
  <h1>Renaissance</h1>
  <p>by <a href="/person/beyonce/">Beyoncé</a></p>
  <div>Metascore <span>91</span></div>
  <p>Universal acclaim - based on 26 Critic Reviews</p>
`;

const AOTY_HTML = `
  <meta property="og:title" content="Mitski - Nothing's About to Happen to Me | Album of the Year" />
  <div class="artist"><span itemprop="byArtist" itemscope itemtype="http://schema.org/MusicGroup"><span itemprop="name"><a href="/artist/9437-mitski/">Mitski</a></span></span></div>
  <h1 class="albumTitle"><span itemprop="name">Nothing&#039;s About to Happen to Me</span></h1>
  <div class="albumCriticScoreBox">
    <div class="heading">Critic Score</div>
    <div class="albumCriticScore"><a href="#critics">85</a></div>
  </div>
  <div class="albumUserScoreBox">
    <div class="heading">User Score</div>
    <div class="albumUserScore">77</div>
  </div>
  <p>30 Critic Ratings</p>
  <p>10,272 User Ratings</p>
`;

const RECORD_CLUB_PAYLOAD = {
  success: true,
  data: {
    title: "Lost Weekend",
    releaseDate: { year: 2026, month: 7, day: 14 },
    artists: [{ name: "Phoebe Bridgers" }],
    stats: {
      listens: 136,
      rating: { average: 3.95, count: 77 },
    },
  },
};

test("豆瓣音乐评分解析保留评分、人数与发行身份", () => {
  assert.deepEqual(
    parseDoubanMusicRating(
      DOUBAN_HTML,
      "https://music.douban.com/subject/25709562/",
    ),
    {
      provider: "DOUBAN",
      providerLabel: "豆瓣",
      score: 8.9,
      scale: 10,
      ratingCount: 56775,
      title: "安和桥北",
      artist: "宋冬野",
      releaseDate: "2013-08-26",
      url: "https://music.douban.com/subject/25709562/",
    },
  );
});

test("平台评分只接受 NeoDB 精确外链及匹配的豆瓣条目", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("/api/album/abc123")) {
      return new Response(
        JSON.stringify({
          external_resources: [
            { url: "https://music.douban.com/subject/25709562/" },
            { url: "https://www.albumoftheyear.org/album/example.php" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return Object.defineProperty(new Response(DOUBAN_HTML, { status: 200 }), "url", {
      value: "https://music.douban.com/subject/25709562/",
    });
  };
  const result = await refreshExternalRatings(
    {
      id: "release-1",
      title: "安和桥北",
      artists: ["宋冬野"],
      releaseDate: "2013-08-26",
      externalLinks: [
        {
          provider: "NEODB",
          status: "CONFIRMED",
          url: "https://neodb.social/album/abc123",
        },
      ],
    },
    { fetchImpl },
  );
  assert.equal(result.status, "SUCCESS");
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].provider, "DOUBAN");
  assert.equal(result.sources[0].score, 8.9);
  assert.equal(result.sources[0].matchedVia, "NEODB_EXTERNAL_RESOURCE");
});

test("多个匹配的豆瓣候选取评分人数最多的作为专辑得分", async () => {
  const fewerVotesHtml = `
    <meta property="og:title" content="安和桥北" />
    <meta property="music:musician" content="宋冬野" />
    <span class="pl">发行时间:</span>&nbsp;2013-08-26<br />
    <strong class="ll rating_num" property="v:average">9.2</strong>
    <span property="v:votes">120</span>人评价
  `;
  const moreVotesHtml = `
    <meta property="og:title" content="安和桥北" />
    <meta property="music:musician" content="宋冬野" />
    <span class="pl">发行时间:</span>&nbsp;2013<br />
    <strong class="ll rating_num" property="v:average">8.5</strong>
    <span property="v:votes">56,775</span>人评价
  `;
  const fetchImpl = async (url) => {
    const target = String(url);
    if (target.includes("/api/album/abc123")) {
      return new Response(
        JSON.stringify({
          external_resources: [
            { url: "https://music.douban.com/subject/11111111/" },
            { url: "https://music.douban.com/subject/25709562/" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (target.includes("/subject/11111111/")) {
      return Object.defineProperty(new Response(fewerVotesHtml, { status: 200 }), "url", {
        value: "https://music.douban.com/subject/11111111/",
      });
    }
    return Object.defineProperty(new Response(moreVotesHtml, { status: 200 }), "url", {
      value: "https://music.douban.com/subject/25709562/",
    });
  };
  const result = await refreshExternalRatings(
    {
      id: "release-douban-votes",
      title: "安和桥北",
      artists: ["宋冬野"],
      releaseDate: "2013-08-26",
      externalLinks: [
        {
          provider: "NEODB",
          status: "CONFIRMED",
          url: "https://neodb.social/album/abc123",
        },
      ],
    },
    { fetchImpl },
  );
  assert.equal(result.status, "SUCCESS");
  assert.equal(result.sources[0].provider, "DOUBAN");
  assert.equal(result.sources[0].score, 8.5);
  assert.equal(result.sources[0].ratingCount, 56775);
  assert.equal(result.sources[0].url, "https://music.douban.com/subject/25709562/");
});

test("平台评分属于可持久化的发行元数据", () => {
  assert.ok(getReleaseMetadataFields().includes("externalRatings"));
});

test("手动评分链接只接受指定平台的 HTTPS 专辑页", () => {
  const links = normalizeExternalRatingLinks([
    { url: "https://music.douban.com/subject/25709562/?from=subject_search" },
    { url: "https://www.albumoftheyear.org/album/123-example.php?x=1" },
    { url: "https://rateyourmusic.com/release/album/artist/title/" },
    { url: "https://www.metacritic.com/music/renaissance/beyonce" },
    {
      url: "https://record.club/releases/albums/phoebe-bridgers-lost-weekend?from=share",
    },
    { url: "http://www.metacritic.com/music/unsafe/example" },
    { url: "https://example.com/album/not-supported" },
    { url: "https://www.douban.com/subject/25709562/" },
  ]);
  assert.deepEqual(
    links.map((link) => [link.provider, link.fetchPolicy, link.url]),
    [
      [
        "DOUBAN",
        "ON_DEMAND",
        "https://music.douban.com/subject/25709562/",
      ],
      ["AOTY", "ON_DEMAND", "https://www.albumoftheyear.org/album/123-example.php"],
      [
        "RATEYOURMUSIC",
        "MANUAL_LINK_ONLY",
        "https://rateyourmusic.com/release/album/artist/title",
      ],
      [
        "METACRITIC",
        "ON_DEMAND",
        "https://www.metacritic.com/music/renaissance/beyonce",
      ],
      [
        "RECORD_CLUB",
        "ON_DEMAND",
        "https://record.club/releases/albums/phoebe-bridgers-lost-weekend",
      ],
    ],
  );
});

test("手动豆瓣链接按需取分，并优先于 NeoDB 外链", async () => {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(String(url));
    if (String(url).includes("/api/album/")) {
      return new Response(
        JSON.stringify({
          external_resources: [
            { url: "https://music.douban.com/subject/11111111/" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return Object.defineProperty(new Response(DOUBAN_HTML, { status: 200 }), "url", {
      value: "https://music.douban.com/subject/25709562/",
    });
  };
  const result = await refreshExternalRatings(
    {
      id: "release-manual-douban",
      title: "安和桥北",
      artists: ["宋冬野"],
      externalLinks: [
        {
          provider: "NEODB",
          status: "CONFIRMED",
          url: "https://neodb.social/album/abc123",
        },
      ],
      ratingLinks: [{ url: "https://music.douban.com/subject/25709562/" }],
    },
    { fetchImpl },
  );
  assert.deepEqual(requested, [
    "https://neodb.social/api/album/abc123",
    "https://music.douban.com/subject/25709562/",
  ]);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].provider, "DOUBAN");
  assert.equal(result.sources[0].score, 8.9);
  assert.equal(result.sources[0].matchedVia, "USER_CONFIRMED_LINK");
  assert.equal(result.links[0].status, "SCORE_UPDATED");
});

test("仅手动豆瓣链接、无 NeoDB 时也能取分", async () => {
  const result = await refreshExternalRatings(
    {
      id: "release-douban-only",
      title: "安和桥北",
      artists: ["宋冬野"],
      ratingLinks: [{ url: "https://music.douban.com/subject/25709562/" }],
    },
    {
      fetchImpl: async () =>
        Object.defineProperty(new Response(DOUBAN_HTML, { status: 200 }), "url", {
          value: "https://music.douban.com/subject/25709562/",
        }),
    },
  );
  assert.equal(result.status, "SUCCESS");
  assert.equal(result.sources[0].provider, "DOUBAN");
  assert.equal(result.sources[0].matchedVia, "USER_CONFIRMED_LINK");
});

test("Record Club 读取页面对应的平均分、评分人数与发行身份", () => {
  assert.deepEqual(
    parseRecordClubRating(
      RECORD_CLUB_PAYLOAD,
      "https://record.club/releases/albums/phoebe-bridgers-lost-weekend",
    ),
    {
      provider: "RECORD_CLUB",
      providerLabel: "Record Club",
      score: 4,
      scale: 5,
      ratingCount: 77,
      listenerCount: 136,
      title: "Lost Weekend",
      artist: "Phoebe Bridgers",
      releaseDate: "2026-08-14",
      url: "https://record.club/releases/albums/phoebe-bridgers-lost-weekend",
    },
  );
});

test("AOTY 专辑页分开保留媒体分与用户分", () => {
  assert.deepEqual(
    parseAotyMusicRating(
      AOTY_HTML,
      "https://www.albumoftheyear.org/album/1617518-mitski-nothings-about-to-happen-to-me.php",
    ),
    {
      provider: "AOTY",
      providerLabel: "AOTY",
      score: 77,
      criticScore: 85,
      userScore: 77,
      scale: 100,
      ratingCount: 10272,
      criticCount: 30,
      userCount: 10272,
      title: "Nothing's About to Happen to Me",
      artist: "Mitski",
      url: "https://www.albumoftheyear.org/album/1617518-mitski-nothings-about-to-happen-to-me.php",
    },
  );
});

test("Metacritic 音乐页解析媒体分与评论数", () => {
  assert.deepEqual(
    parseMetacriticMusicRating(
      METACRITIC_HTML,
      "https://www.metacritic.com/music/renaissance/beyonce",
    ),
    {
      provider: "METACRITIC",
      providerLabel: "Metacritic",
      score: 91,
      scale: 100,
      ratingCount: 26,
      title: "Renaissance",
      artist: "Beyoncé",
      url: "https://www.metacritic.com/music/renaissance/beyonce",
    },
  );
});

test("刷新会对 Metacritic 与 AOTY 用户确认链接按需取分，并保留 RYM 仅链接", async () => {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(String(url));
    if (String(url).includes("albumoftheyear.org")) {
      return Object.defineProperty(new Response(AOTY_HTML, { status: 200 }), "url", {
        value:
          "https://www.albumoftheyear.org/album/1617518-mitski-nothings-about-to-happen-to-me.php",
      });
    }
    return Object.defineProperty(new Response(METACRITIC_HTML, { status: 200 }), "url", {
      value: "https://www.metacritic.com/music/renaissance/beyonce",
    });
  };
  const result = await refreshExternalRatings(
    {
      id: "release-2",
      title: "Renaissance",
      artists: ["Beyoncé"],
      ratingLinks: [
        { url: "https://www.metacritic.com/music/renaissance/beyonce" },
        {
          url: "https://www.albumoftheyear.org/album/1617518-mitski-nothings-about-to-happen-to-me.php",
        },
        { url: "https://rateyourmusic.com/release/album/beyonce/renaissance/" },
      ],
    },
    { fetchImpl },
  );
  assert.deepEqual(requested.sort(), [
    "https://www.albumoftheyear.org/album/1617518-mitski-nothings-about-to-happen-to-me.php",
    "https://www.metacritic.com/music/renaissance/beyonce",
  ]);
  assert.equal(result.sources.length, 2);
  assert.equal(
    result.sources.find((source) => source.provider === "METACRITIC")?.score,
    91,
  );
  assert.equal(
    result.sources.find((source) => source.provider === "AOTY")?.userScore,
    77,
  );
  assert.deepEqual(
    result.links.map((link) => [link.provider, link.status]),
    [
      ["METACRITIC", "SCORE_UPDATED"],
      ["AOTY", "SCORE_UPDATED"],
      ["RATEYOURMUSIC", "LINK_SAVED"],
    ],
  );
});

test("刷新 Record Club 链接会从公开 API 取分，并信任用户确认链接", async () => {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(String(url));
    return new Response(JSON.stringify(RECORD_CLUB_PAYLOAD), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const result = await refreshExternalRatings(
    {
      id: "release-record-club",
      title: "Lost Weekend",
      artists: ["Phoebe Bridgers"],
      releaseDate: "2026-08-14",
      ratingLinks: [
        {
          url: "https://record.club/releases/albums/phoebe-bridgers-lost-weekend",
        },
      ],
    },
    { fetchImpl },
  );

  assert.deepEqual(requested, [
    "https://api.record.club/releases/albums/phoebe-bridgers-lost-weekend",
  ]);
  assert.equal(result.status, "SUCCESS");
  assert.equal(result.sources[0].provider, "RECORD_CLUB");
  assert.equal(result.sources[0].score, 4);
  assert.equal(result.sources[0].ratingCount, 77);
  assert.equal(result.sources[0].listenerCount, 136);
  assert.equal(result.links[0].status, "SCORE_UPDATED");
});

test("Record Club 用户确认链接即使本地标题不同也写入评分", async () => {
  const result = await refreshExternalRatings(
    {
      id: "release-record-club-zh-title",
      title: "迷失周末",
      artists: ["菲比·布里杰斯"],
      ratingLinks: [
        {
          url: "https://record.club/releases/albums/phoebe-bridgers-lost-weekend",
        },
      ],
    },
    {
      fetchImpl: async () =>
        new Response(JSON.stringify(RECORD_CLUB_PAYLOAD), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    },
  );

  assert.equal(result.status, "SUCCESS");
  assert.equal(result.sources[0].provider, "RECORD_CLUB");
  assert.equal(result.sources[0].score, 4);
  assert.equal(result.links[0].status, "SCORE_UPDATED");
});

test("AOTY 被拦截时保留上次分数并标记 blocked", async () => {
  const result = await refreshExternalRatings(
    {
      id: "release-aoty-blocked",
      title: "Nothing's About to Happen to Me",
      artists: ["Mitski"],
      ratingLinks: [
        {
          url: "https://www.albumoftheyear.org/album/1617518-mitski-nothings-about-to-happen-to-me.php",
        },
      ],
      externalRatings: {
        sources: [
          {
            provider: "AOTY",
            providerLabel: "AOTY",
            score: 77,
            criticScore: 85,
            userScore: 77,
            scale: 100,
            url: "https://www.albumoftheyear.org/album/1617518-mitski-nothings-about-to-happen-to-me.php",
          },
        ],
      },
    },
    {
      fetchImpl: async () =>
        new Response("<html>Just a moment...</html>", { status: 403 }),
    },
  );

  assert.equal(result.status, "SUCCESS");
  assert.deepEqual(result.blockedProviders, ["AOTY"]);
  assert.equal(result.sources[0].userScore, 77);
  assert.equal(result.links[0].status, "SCORE_BLOCKED");
});
