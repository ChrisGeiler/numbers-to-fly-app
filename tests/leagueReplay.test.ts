import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLeagueReplay, replayPointAt } from "../src/leagueReplay.ts";
import { leagueWindow, scoreLeagueWindow, LEAGUE_WIND_MODEL } from "../src/leagueScoring.ts";
import { rankLeagueScoreboard } from "../src/leagueScoreboardModel.ts";
import type { LeagueScoreboardEntry } from "../src/leagueScoreboardModel.ts";
import { buildLeagueCompRun, compRunWindow } from "../src/leagueCompRun.ts";
import {competitionLaneGeometry} from "../src/competitionLaneFlight.ts";
import {estimateLanePenalty} from "../src/competitionLaneMath.ts";
import { getValidatedJumpTrack, parseFlySightCsv } from "../src/gpsAnalysis.ts";
const base = Date.parse("2026-11-01T00:00:00Z");
function csv() {
  const rows = ["time,lat,lon,hMSL,velN,velE,velD,hAcc,vAcc,sAcc,numSV"];
  for(let i=0;i<520;i++) rows.push([new Date(base+i*200).toISOString(),-33+i*6/6371000*180/Math.PI,151+i*8/6371000*180/Math.PI/Math.cos(-33*Math.PI/180),3300-Math.max(0,i-25)*4,30,40,i<25?0:20,1,2,0.5,17].join(","));
  return rows.join("\n");
}
const winds = { model: LEAGUE_WIND_MODEL, fetched_at: new Date(base).toISOString(),
  hours: [base,base+3600000].map(time => ({time,levels:[0,5000].map(height => ({height,north:10,east:-5}))})) };

test("full comp run shares analyser exit detection, interpolates 1450 AGL and publishes no GPS/time identity",()=>{
  const run=buildLeagueCompRun(csv(),100,winds);
  const expected=getValidatedJumpTrack(parseFlySightCsv(csv()),100);
  assert.equal(run.points[0].altitudeM,expected.exitPoint!.altitudeM-100);
  assert.equal(run.points[0].seconds,0);
  assert.ok(run.points[0].altitudeM>2500);
  assert.equal(run.points.at(-1)!.altitudeM,1450);
  assert.ok(run.points.at(-1)!.seconds>scoreLeagueWindow(leagueWindow(csv(),100),winds).time_s);
  assert.equal(run.correctedAvailable,true);
  const window=compRunWindow(run)!;
  const score=scoreLeagueWindow(leagueWindow(csv(),100),winds);
  assert.ok(window.start>0 && window.end<run.points.at(-1)!.seconds);
  assert.ok(Math.abs(window.end-window.start-score.time_s)<0.000001);
  assert.ok(Math.abs(run.points[10].airspeedMps!-Math.hypot(20,45))<1e-8);
  assert.deepEqual(Object.keys(run.points[0]).sort(),["seconds","altitudeM","horizontalSpeedMps","verticalSpeedMps","airspeedMps"].sort());
  assert.ok(!JSON.stringify(run).includes("2026-11-01"));
  assert.ok(!JSON.stringify(run).includes('"lat"'));
  const raw=buildLeagueCompRun(csv(),100,{...winds,hours:[]});
  assert.equal(raw.correctedAvailable,false);
  assert.ok(raw.points.every(point=>point.airspeedMps===null));
  const incomplete=csv().split("\n").slice(0,420).join("\n");
  assert.throws(()=>buildLeagueCompRun(incomplete,100,winds),/1,450/);
});

test("wind-corrected replay finishes at exactly the published displacement and elapsed time", () => {
  const replay = buildLeagueReplay(csv(), 100, winds);
  const scores = scoreLeagueWindow(leagueWindow(csv(),100),winds);
  const first = replay.points[0], last = replay.points.at(-1)!;
  assert.equal(first.seconds,0); assert.equal(first.altitudeM,2500);
  assert.equal(first.forwardM,0); assert.equal(first.lateralM,0);
  assert.equal(last.altitudeM,1500); assert.equal(last.seconds,scores.time_s);
  assert.ok(Math.abs(last.forwardM-scores.corrected_distance_m)<1e-8);
  assert.ok(Math.abs(last.lateralM)<1e-8);
  assert.ok(Math.abs(last.forwardM-scores.raw_distance_m)>1);
  assert.equal(replay.provider,"open-meteo");
  assert.deepEqual(Object.keys(first).sort(),["seconds","altitudeM","forwardM","lateralM","speedKmh"].sort());
  assert.ok(!JSON.stringify(replay).includes("2026-11-01"));
});
test("replay interpolates the playhead and freezes each track at its own finish", () => {
  const replay = buildLeagueReplay(csv(),100,winds);
  const a = replay.points[10], b = replay.points[11];
  const midway = replayPointAt(replay.points,(a.seconds+b.seconds)/2);
  assert.ok(Math.abs(midway.altitudeM-(a.altitudeM+b.altitudeM)/2)<1e-8);
  assert.equal(replayPointAt(replay.points,999),replay.points.at(-1));
  assert.equal(replayPointAt(replay.points,-1),replay.points[0]);
  assert.throws(()=>buildLeagueReplay(csv(),100,{...winds,hours:[]}),/wind/);
});

function entry(id:string,pilot:string,discipline:LeagueScoreboardEntry["discipline"],value:number):LeagueScoreboardEntry {
  return { id, competitor_key:pilot, public_name:pilot, region:"NSWPC",discipline,attempt:1,replay_available:true,
    time_s:discipline==="time"?value:50, corrected_speed_kmh:discipline==="speed"?value:180,
    corrected_distance_m:discipline==="distance"?value:2500,raw_speed_kmh:180,raw_distance_m:2500 };
}
test("round scoreboard counts best approved attempt only, preserves ties and zero for missing tasks", () => {
  const rows=[entry("a","A","speed",200),{...entry("b","A","speed",180),attempt:2},entry("c","B","speed",200),entry("d","A","time",50),entry("e","B","time",50)];
  const result=rankLeagueScoreboard(rows);
  assert.equal(result.rows.length,2);
  assert.equal(result.rows[0].total,200);assert.equal(result.rows[1].total,200);
  assert.equal(result.rows[0].rank,1);assert.equal(result.rows[1].rank,1);
  assert.equal(result.rows[0].points.distance,0);
  assert.equal(result.rows[0].entries.length,3);
  assert.equal(rankLeagueScoreboard(rows,"speed").leaders.speed,200);
  const complete=rankLeagueScoreboard([entry("s","A","speed",200),entry("t","A","time",50),entry("d","A","distance",3000)]);
  assert.equal(complete.rows[0].total,300);
  assert.ok(Object.values(complete.rows[0].points).every(value=>value===100));
});

test("category leaders and round points stay independent even for the same competitor", () => {
  const rows = [
    {...entry("b1","A","speed",120),category:"beginner" as const},
    {...entry("b2","B","speed",100),category:"beginner" as const},
    {...entry("i1","A","speed",200),category:"intermediate" as const},
    entry("o1","A","speed",300),
  ];
  const beginner = rankLeagueScoreboard(rows,"overall","beginner");
  assert.equal(beginner.leaders.speed,120);
  assert.equal(beginner.rows.length,2);
  assert.equal(beginner.rows[0].total,100);
  assert.equal(beginner.rows[0].entries[0].id,"b1");
  assert.ok(Math.abs(beginner.rows[1].total-100*100/120)<1e-8);
  assert.equal(rankLeagueScoreboard(rows,"speed","intermediate").leaders.speed,200);
  assert.equal(rankLeagueScoreboard(rows).leaders.speed,300);
  for (const category of ["beginner","intermediate","open"] as const) {
    const complete = ["speed","time","distance"].map((task,index)=>({
      ...entry(`${category}-${index}`,"Winner",task as LeagueScoreboardEntry["discipline"],100),category,
    }));
    assert.equal(rankLeagueScoreboard([...rows,...complete],"overall",category).rows.find(row=>row.name==="Winner")!.points.time,100);
    assert.ok(rankLeagueScoreboard([...rows,...complete],"overall",category).rows.every(row=>row.total<=300));
  }
});


test("reference map contains only the clipped ground flight and never changes graph metrics", () => {
  const source=csv(), ref={name:"Finish",lat:-32.97,lon:151.03};
  const legacy=buildLeagueCompRun(source,100,winds);
  const mapped=buildLeagueCompRun(source,100,winds,ref);
  assert.deepEqual(mapped.points,legacy.points);
  assert.equal(mapped.map!.points.at(-1)!.altitudeM,1450);
  assert.deepEqual(mapped.map!.reference,ref);
  assert.deepEqual(Object.keys(mapped.map!.points[0]).sort(),["altitudeM","lat","lon"]);
  assert.ok(!JSON.stringify(mapped).includes("2026-11-01"));
});


test("league map uses the analyser Point A, evaluation interval and lane estimate",()=>{
  const source=csv(),ref={name:"Finish",lat:-32.97,lon:151.03};
  const validated=getValidatedJumpTrack(parseFlySightCsv(source),100);
  const geometry=competitionLaneGeometry(validated.jumpPoints.map(p=>({...p,altitudeM:p.altitudeM-100})));
  const mapped=buildLeagueCompRun(source,100,winds,ref).map!;
  assert.equal(mapped.lane!.version,1);
  assert.deepEqual(mapped.lane!.pointA,{lat:geometry.pointA!.lat,lon:geometry.pointA!.lon});
  assert.deepEqual(mapped.lane!.penalty,estimateLanePenalty(geometry.evaluationPoints,geometry.pointA!,ref));
  assert.ok(mapped.lane!.evaluationPoints[0].altitudeM < mapped.points[0].altitudeM);
  assert.equal(mapped.lane!.evaluationPoints[0].altitudeM,geometry.evaluationPoints[0].altitudeM);
  assert.equal(mapped.lane!.windowPoints[0].altitudeM,2500);
  assert.equal(mapped.lane!.windowPoints.at(-1)!.altitudeM,1500);
  assert.equal(mapped.lane!.winds.length,5);
  assert.ok(mapped.lane!.winds.every(w=>Math.abs(Number(w.speedKt)-Math.hypot(10,-5)/0.514444)<1e-8));
  assert.ok(!JSON.stringify(mapped).includes("timestampMs"));
});

test("shared lane estimate retains the app's 600 m lane and penalty bands",()=>{
  const a={lat:0,lon:0},b={lat:0.1,lon:0};
  const metresPerDegreeLon=Math.PI/180*6371000*Math.cos(0.05*Math.PI/180);
  const result=(distance:number)=>estimateLanePenalty([{lat:0.05,lon:distance/metresPerDegreeLon}],a,b)!;
  assert.equal(result(299).severity,"none");
  assert.equal(result(301).severity,"ten");
  assert.equal(result(449).severity,"ten");
  assert.equal(result(451).severity,"twenty");
  assert.equal(result(599).severity,"twenty");
  assert.equal(result(601).severity,"major");
  assert.equal(estimateLanePenalty([a],a,a),null);
});
