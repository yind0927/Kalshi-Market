/* worldcup-data.js — Static seed data for all 48 WC 2026 teams & 12 groups.
 * Elos: eloratings.net scale as of 2026-06-10 (pre-tournament).
 * R1 results confirmed as of 2026-06-17. R2/R3 KO times approximate.
 * Fixture pairings follow pre-drawn FIFA schedule (varies per group). */
window.KW_WC_DATA = (function () {
  "use strict";

  const TEAMS = {
    // ── Group A ──────────────────────────────────────────────
    MEX: { name:"Mexico",        cn:"墨西哥",         flag:"🇲🇽", fifaRank:15, elo0:1760 },
    RSA: { name:"South Africa",  cn:"南非",           flag:"🇿🇦", fifaRank:60, elo0:1640 },
    KOR: { name:"South Korea",   cn:"韩国",           flag:"🇰🇷", fifaRank:25, elo0:1740 },
    CZE: { name:"Czechia",       cn:"捷克",           flag:"🇨🇿", fifaRank:40, elo0:1740 },
    // ── Group B ──────────────────────────────────────────────
    CAN: { name:"Canada",        cn:"加拿大",         flag:"🇨🇦", fifaRank:43, elo0:1800 },
    BIH: { name:"Bosnia & Herz.",cn:"波黑",           flag:"🇧🇦", fifaRank:64, elo0:1627 },
    QAT: { name:"Qatar",         cn:"卡塔尔",         flag:"🇶🇦", fifaRank:56, elo0:1500 },
    SUI: { name:"Switzerland",   cn:"瑞士",           flag:"🇨🇭", fifaRank:19, elo0:1897 },
    // ── Group C ──────────────────────────────────────────────
    BRA: { name:"Brazil",        cn:"巴西",           flag:"🇧🇷", fifaRank:6,  elo0:1978 },
    MAR: { name:"Morocco",       cn:"摩洛哥",         flag:"🇲🇦", fifaRank:8,  elo0:1810 },
    HAI: { name:"Haiti",         cn:"海地",           flag:"🇭🇹", fifaRank:100,elo0:1576 },
    SCO: { name:"Scotland",      cn:"苏格兰",         flag:"🏴󠁧󠁢󠁳󠁣󠁴󠁿", fifaRank:42, elo0:1740 },
    // ── Group D ──────────────────────────────────────────────
    USA: { name:"United States", cn:"美国",           flag:"🇺🇸", fifaRank:16, elo0:1840 },
    PAR: { name:"Paraguay",      cn:"巴拉圭",         flag:"🇵🇾", fifaRank:41, elo0:1760 },
    AUS: { name:"Australia",     cn:"澳大利亚",       flag:"🇦🇺", fifaRank:27, elo0:1760 },
    TUR: { name:"Türkiye",       cn:"土耳其",         flag:"🇹🇷", fifaRank:22, elo0:1880 },
    // ── Group E ──────────────────────────────────────────────
    GER: { name:"Germany",       cn:"德国",           flag:"🇩🇪", fifaRank:10, elo0:1910 },
    CUW: { name:"Curaçao",       cn:"库拉索",         flag:"🇨🇼", fifaRank:82, elo0:1385 },
    CIV: { name:"Ivory Coast",   cn:"科特迪瓦",       flag:"🇨🇮", fifaRank:33, elo0:1740 },
    ECU: { name:"Ecuador",       cn:"厄瓜多尔",       flag:"🇪🇨", fifaRank:23, elo0:1933 },
    // ── Group F ──────────────────────────────────────────────
    NED: { name:"Netherlands",   cn:"荷兰",           flag:"🇳🇱", fifaRank:7,  elo0:1959 },
    JPN: { name:"Japan",         cn:"日本",           flag:"🇯🇵", fifaRank:18, elo0:1879 },
    SWE: { name:"Sweden",        cn:"瑞典",           flag:"🇸🇪", fifaRank:38, elo0:1800 },
    TUN: { name:"Tunisia",       cn:"突尼斯",         flag:"🇹🇳", fifaRank:35, elo0:1574 },
    // ── Group G ──────────────────────────────────────────────
    BEL: { name:"Belgium",       cn:"比利时",         flag:"🇧🇪", fifaRank:9,  elo0:1849 },
    EGY: { name:"Egypt",         cn:"埃及",           flag:"🇪🇬", fifaRank:29, elo0:1720 },
    IRN: { name:"Iran",          cn:"伊朗",           flag:"🇮🇷", fifaRank:20, elo0:1737 },
    NZL: { name:"New Zealand",   cn:"新西兰",         flag:"🇳🇿", fifaRank:85, elo0:1594 },
    // ── Group H ──────────────────────────────────────────────
    ESP: { name:"Spain",         cn:"西班牙",         flag:"🇪🇸", fifaRank:2,  elo0:2129 },
    CPV: { name:"Cape Verde",    cn:"佛得角",         flag:"🇨🇻", fifaRank:69, elo0:1503 },
    KSA: { name:"Saudi Arabia",  cn:"沙特",           flag:"🇸🇦", fifaRank:61, elo0:1654 },
    URU: { name:"Uruguay",       cn:"乌拉圭",         flag:"🇺🇾", fifaRank:17, elo0:1890 },
    // ── Group I ──────────────────────────────────────────────
    FRA: { name:"France",        cn:"法国",           flag:"🇫🇷", fifaRank:3,  elo0:2063 },
    SEN: { name:"Senegal",       cn:"塞内加尔",       flag:"🇸🇳", fifaRank:14, elo0:1869 },
    NOR: { name:"Norway",        cn:"挪威",           flag:"🇳🇴", fifaRank:32, elo0:1922 },
    IRQ: { name:"Iraq",          cn:"伊拉克",         flag:"🇮🇶", fifaRank:57, elo0:1626 },
    // ── Group J ──────────────────────────────────────────────
    ARG: { name:"Argentina",     cn:"阿根廷",         flag:"🇦🇷", fifaRank:1,  elo0:2115 },
    ALG: { name:"Algeria",       cn:"阿尔及利亚",     flag:"🇩🇿", fifaRank:28, elo0:1780 },
    AUT: { name:"Austria",       cn:"奥地利",         flag:"🇦🇹", fifaRank:24, elo0:1820 },
    JOR: { name:"Jordan",        cn:"约旦",           flag:"🇯🇴", fifaRank:63, elo0:1657 },
    // ── Group K ──────────────────────────────────────────────
    POR: { name:"Portugal",      cn:"葡萄牙",         flag:"🇵🇹", fifaRank:5,  elo0:1989 },
    COD: { name:"DR Congo",      cn:"刚果(金)",       flag:"🇨🇩", fifaRank:46, elo0:1724 },
    COL: { name:"Colombia",      cn:"哥伦比亚",       flag:"🇨🇴", fifaRank:13, elo0:1982 },
    UZB: { name:"Uzbekistan",    cn:"乌兹别克斯坦",   flag:"🇺🇿", fifaRank:50, elo0:1645 },
    // ── Group L ──────────────────────────────────────────────
    ENG: { name:"England",       cn:"英格兰",         flag:"🏴󠁧󠁢󠁥󠁮󠁧󠁿", fifaRank:4,  elo0:2024 },
    CRO: { name:"Croatia",       cn:"克罗地亚",       flag:"🇭🇷", fifaRank:11, elo0:1933 },
    GHA: { name:"Ghana",         cn:"加纳",           flag:"🇬🇭", fifaRank:67, elo0:1660 },
    PAN: { name:"Panama",        cn:"巴拿马",         flag:"🇵🇦", fifaRank:34, elo0:1575 },
  };

  function m(id, round, home, away, koUTC, koBJT, venue, result) {
    const o = { id, round, homeCode:home, awayCode:away, koUTC, koBJT, venue };
    if (result) o.result = result;
    return o;
  }
  function fin(h, a) { return { status:"finished", homeScore:h, awayScore:a }; }

  const GROUPS = {
    A: {
      label:"A",
      order:["MEX","RSA","KOR","CZE"],
      matches:[
        m("WC2026-MEX-RSA",1,"MEX","RSA","2026-06-11T22:00:00Z","6/12 06:00","AT&T Stadium · Arlington, TX",              fin(2,0)),
        m("WC2026-KOR-CZE",1,"KOR","CZE","2026-06-12T02:00:00Z","6/12 10:00","SoFi Stadium · Inglewood, CA",              fin(2,1)),
        m("WC2026-MEX-KOR",2,"MEX","KOR","2026-06-19T01:00:00Z","6/19 09:00","Estadio Akron · Guadalajara"),
        m("WC2026-RSA-CZE",2,"RSA","CZE","2026-06-18T22:00:00Z","6/19 06:00","Rose Bowl · Pasadena, CA"),
        m("WC2026-MEX-CZE",3,"MEX","CZE","2026-06-25T01:00:00Z","6/25 09:00","Estadio Akron · Guadalajara"),
        m("WC2026-KOR-RSA",3,"KOR","RSA","2026-06-25T01:00:00Z","6/25 09:00","SoFi Stadium · Inglewood, CA"),
      ],
    },
    B: {
      label:"B",
      order:["CAN","BIH","QAT","SUI"],
      matches:[
        m("WC2026-CAN-BIH",1,"CAN","BIH","2026-06-12T22:00:00Z","6/13 06:00","BMO Field · Toronto, ON",                  fin(1,1)),
        m("WC2026-QAT-SUI",1,"QAT","SUI","2026-06-13T01:00:00Z","6/13 09:00","Allegiant Stadium · Las Vegas, NV",         fin(1,1)),
        m("WC2026-CAN-QAT",2,"CAN","QAT","2026-06-18T22:00:00Z","6/19 06:00","BC Place · Vancouver, BC"),
        m("WC2026-SUI-BIH",2,"SUI","BIH","2026-06-18T18:00:00Z","6/19 02:00","Levi's Stadium · Santa Clara, CA"),
        m("WC2026-SUI-CAN",3,"SUI","CAN","2026-06-24T16:00:00Z","6/25 00:00","Allegiant Stadium · Las Vegas, NV"),
        m("WC2026-BIH-QAT",3,"BIH","QAT","2026-06-24T16:00:00Z","6/25 00:00","BMO Field · Toronto, ON"),
      ],
    },
    C: {
      label:"C",
      order:["BRA","MAR","HAI","SCO"],
      matches:[
        m("WC2026-BRA-MAR",1,"BRA","MAR","2026-06-13T22:00:00Z","6/14 06:00","MetLife Stadium · East Rutherford, NJ",     fin(1,1)),
        m("WC2026-HAI-SCO",1,"HAI","SCO","2026-06-13T19:00:00Z","6/14 03:00","Lincoln Financial Field · Philadelphia, PA",fin(0,1)),
        m("WC2026-SCO-MAR",2,"SCO","MAR","2026-06-19T22:00:00Z","6/20 06:00","Gillette Stadium · Foxborough, MA"),
        m("WC2026-BRA-HAI",2,"BRA","HAI","2026-06-20T01:00:00Z","6/20 09:00","Lincoln Financial Field · Philadelphia, PA"),
        m("WC2026-BRA-SCO",3,"BRA","SCO","2026-06-25T19:00:00Z","6/26 03:00","MetLife Stadium · East Rutherford, NJ"),
        m("WC2026-MAR-HAI",3,"MAR","HAI","2026-06-25T19:00:00Z","6/26 03:00","Gillette Stadium · Foxborough, MA"),
      ],
    },
    D: {
      label:"D",
      order:["USA","PAR","AUS","TUR"],
      matches:[
        m("WC2026-USA-PAR",1,"USA","PAR","2026-06-12T19:00:00Z","6/13 03:00","SoFi Stadium · Inglewood, CA",              fin(4,1)),
        m("WC2026-AUS-TUR",1,"AUS","TUR","2026-06-13T02:00:00Z","6/13 10:00","BC Place · Vancouver, BC",                  fin(2,0)),
        m("WC2026-USA-AUS",2,"USA","AUS","2026-06-19T19:00:00Z","6/20 03:00","Lumen Field · Seattle, WA"),
        m("WC2026-PAR-TUR",2,"PAR","TUR","2026-06-19T23:00:00Z","6/20 07:00","Rose Bowl · Pasadena, CA"),
        m("WC2026-USA-TUR",3,"USA","TUR","2026-06-25T23:00:00Z","6/26 07:00","AT&T Stadium · Arlington, TX"),
        m("WC2026-AUS-PAR",3,"AUS","PAR","2026-06-25T23:00:00Z","6/26 07:00","Lumen Field · Seattle, WA"),
      ],
    },
    E: {
      label:"E",
      order:["GER","CUW","CIV","ECU"],
      matches:[
        m("WC2026-GER-CUW",1,"GER","CUW","2026-06-14T22:00:00Z","6/15 06:00","Arrowhead Stadium · Kansas City, MO",       fin(7,1)),
        m("WC2026-CIV-ECU",1,"CIV","ECU","2026-06-14T19:00:00Z","6/15 03:00","NRG Stadium · Houston, TX",                 fin(1,0)),
        m("WC2026-GER-CIV",2,"GER","CIV","2026-06-20T20:00:00Z","6/21 04:00","BMO Field · Toronto, ON"),
        m("WC2026-ECU-CUW",2,"ECU","CUW","2026-06-21T00:00:00Z","6/21 08:00","Arrowhead Stadium · Kansas City, MO"),
        m("WC2026-GER-ECU",3,"GER","ECU","2026-06-25T23:00:00Z","6/26 07:00","Mercedes-Benz Stadium · Atlanta, GA"),
        m("WC2026-CIV-CUW",3,"CIV","CUW","2026-06-25T23:00:00Z","6/26 07:00","BMO Field · Toronto, ON"),
      ],
    },
    F: {
      label:"F",
      order:["NED","JPN","SWE","TUN"],
      matches:[
        m("WC2026-NED-JPN",1,"NED","JPN","2026-06-14T23:00:00Z","6/15 07:00","NRG Stadium · Houston, TX",                 fin(2,2)),
        m("WC2026-SWE-TUN",1,"SWE","TUN","2026-06-14T19:00:00Z","6/15 03:00","Lumen Field · Seattle, WA",                 fin(5,1)),
        m("WC2026-NED-SWE",2,"NED","SWE","2026-06-20T17:00:00Z","6/21 01:00","NRG Stadium · Houston, TX"),
        m("WC2026-TUN-JPN",2,"TUN","JPN","2026-06-21T04:00:00Z","6/21 12:00","Estadio Akron · Guadalajara"),
        m("WC2026-NED-TUN",3,"NED","TUN","2026-06-25T19:00:00Z","6/26 03:00","Hard Rock Stadium · Miami Gardens, FL"),
        m("WC2026-JPN-SWE",3,"JPN","SWE","2026-06-25T19:00:00Z","6/26 03:00","Rose Bowl · Pasadena, CA"),
      ],
    },
    G: {
      label:"G",
      order:["BEL","EGY","IRN","NZL"],
      matches:[
        m("WC2026-BEL-EGY",1,"BEL","EGY","2026-06-15T22:00:00Z","6/16 06:00","SoFi Stadium · Inglewood, CA",             fin(1,1)),
        m("WC2026-IRN-NZL",1,"IRN","NZL","2026-06-15T18:00:00Z","6/16 02:00","Levi's Stadium · Santa Clara, CA",          fin(2,2)),
        m("WC2026-BEL-IRN",2,"BEL","IRN","2026-06-21T19:00:00Z","6/22 03:00","SoFi Stadium · Inglewood, CA"),
        m("WC2026-NZL-EGY",2,"NZL","EGY","2026-06-22T01:00:00Z","6/22 09:00","BC Place · Vancouver, BC"),
        m("WC2026-BEL-NZL",3,"BEL","NZL","2026-06-26T01:00:00Z","6/26 09:00","Mercedes-Benz Stadium · Atlanta, GA"),
        m("WC2026-EGY-IRN",3,"EGY","IRN","2026-06-26T01:00:00Z","6/26 09:00","Hard Rock Stadium · Miami Gardens, FL"),
      ],
    },
    H: {
      label:"H",
      order:["ESP","CPV","KSA","URU"],
      matches:[
        m("WC2026-ESP-CPV",1,"ESP","CPV","2026-06-15T18:00:00Z","6/16 02:00","Mercedes-Benz Stadium · Atlanta, GA",       fin(0,0)),
        m("WC2026-KSA-URU",1,"KSA","URU","2026-06-15T22:00:00Z","6/16 06:00","Hard Rock Stadium · Miami Gardens, FL",     fin(1,1)),
        m("WC2026-ESP-KSA",2,"ESP","KSA","2026-06-21T16:00:00Z","6/22 00:00","Mercedes-Benz Stadium · Atlanta, GA"),
        m("WC2026-URU-CPV",2,"URU","CPV","2026-06-21T20:00:00Z","6/22 04:00","Hard Rock Stadium · Miami Gardens, FL"),
        m("WC2026-ESP-URU",3,"ESP","URU","2026-06-26T01:00:00Z","6/26 09:00","AT&T Stadium · Arlington, TX"),
        m("WC2026-KSA-CPV",3,"KSA","CPV","2026-06-26T01:00:00Z","6/26 09:00","Levi's Stadium · Santa Clara, CA"),
      ],
    },
    I: {
      label:"I",
      order:["FRA","SEN","NOR","IRQ"],
      matches:[
        m("WC2026-FRA-SEN",1,"FRA","SEN","2026-06-16T19:00:00Z","6/17 03:00","MetLife Stadium · East Rutherford, NJ",
          { status:"finished", homeScore:3, awayScore:1, minute:96, source:"FIFA",
            scorers:[{name:"Mbappé",min:66,team:"home"},{name:"Barcola",min:82,team:"home"},{name:"I. Mbaye",min:95,team:"away"},{name:"Mbappé",min:96,team:"home"}] }),
        m("WC2026-NOR-IRQ",1,"NOR","IRQ","2026-06-16T23:00:00Z","6/17 07:00","Gillette Stadium · Foxborough, MA",         fin(4,1)),
        m("WC2026-FRA-IRQ",2,"FRA","IRQ","2026-06-22T21:00:00Z","6/23 05:00","Lincoln Financial Field · Philadelphia, PA"),
        m("WC2026-NOR-SEN",2,"NOR","SEN","2026-06-23T00:00:00Z","6/23 08:00","MetLife Stadium · East Rutherford, NJ"),
        m("WC2026-NOR-FRA",3,"NOR","FRA","2026-06-26T19:00:00Z","6/27 03:00","Gillette Stadium · Foxborough, MA"),
        m("WC2026-SEN-IRQ",3,"SEN","IRQ","2026-06-26T19:00:00Z","6/27 03:00","BMO Field · Toronto, ON"),
      ],
    },
    J: {
      label:"J",
      order:["ARG","ALG","AUT","JOR"],
      matches:[
        m("WC2026-ARG-ALG",1,"ARG","ALG","2026-06-16T22:00:00Z","6/17 06:00","Allegiant Stadium · Las Vegas, NV",         fin(3,0)),
        m("WC2026-AUT-JOR",1,"AUT","JOR","2026-06-17T12:00:00Z","6/17 20:00","Levi's Stadium · Santa Clara, CA"),
        m("WC2026-ARG-AUT",2,"ARG","AUT","2026-06-22T16:00:00Z","6/23 00:00","AT&T Stadium · Arlington, TX"),
        m("WC2026-ALG-JOR",2,"ALG","JOR","2026-06-22T20:00:00Z","6/23 04:00","Arrowhead Stadium · Kansas City, MO"),
        m("WC2026-ARG-JOR",3,"ARG","JOR","2026-06-26T23:00:00Z","6/27 07:00","Allegiant Stadium · Las Vegas, NV"),
        m("WC2026-AUT-ALG",3,"AUT","ALG","2026-06-26T23:00:00Z","6/27 07:00","Levi's Stadium · Santa Clara, CA"),
      ],
    },
    K: {
      label:"K",
      order:["POR","COD","COL","UZB"],
      matches:[
        m("WC2026-POR-COD",1,"POR","COD","2026-06-17T17:00:00Z","6/18 01:00","NRG Stadium · Houston, TX"),
        m("WC2026-COL-UZB",1,"COL","UZB","2026-06-18T02:00:00Z","6/18 10:00","Estadio Azteca · Mexico City"),
        m("WC2026-POR-UZB",2,"POR","UZB","2026-06-23T17:00:00Z","6/24 01:00","NRG Stadium · Houston, TX"),
        m("WC2026-COL-COD",2,"COL","COD","2026-06-23T21:00:00Z","6/24 05:00","Estadio BBVA · Monterrey"),
        m("WC2026-COL-POR",3,"COL","POR","2026-06-27T19:00:00Z","6/28 03:00","Estadio Azteca · Mexico City"),
        m("WC2026-COD-UZB",3,"COD","UZB","2026-06-27T19:00:00Z","6/28 03:00","NRG Stadium · Houston, TX"),
      ],
    },
    L: {
      label:"L",
      order:["ENG","CRO","GHA","PAN"],
      matches:[
        m("WC2026-ENG-CRO",1,"ENG","CRO","2026-06-17T20:00:00Z","6/18 04:00","AT&T Stadium · Arlington, TX"),
        m("WC2026-GHA-PAN",1,"GHA","PAN","2026-06-17T23:00:00Z","6/18 07:00","BMO Field · Toronto, ON"),
        m("WC2026-ENG-PAN",2,"ENG","PAN","2026-06-23T16:00:00Z","6/24 00:00","Lincoln Financial Field · Philadelphia, PA"),
        m("WC2026-GHA-CRO",2,"GHA","CRO","2026-06-23T20:00:00Z","6/24 04:00","Allegiant Stadium · Las Vegas, NV"),
        m("WC2026-GHA-ENG",3,"GHA","ENG","2026-06-27T23:00:00Z","6/28 07:00","AT&T Stadium · Arlington, TX"),
        m("WC2026-CRO-PAN",3,"CRO","PAN","2026-06-27T23:00:00Z","6/28 07:00","BMO Field · Toronto, ON"),
      ],
    },
  };

  return { TEAMS, GROUPS };
})();
