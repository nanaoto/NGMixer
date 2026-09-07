import assert from "node:assert/strict";
import test from "node:test";

import { effectChainTemplates, vocalMixProject } from "../src/mixing/blueprints.js";

test("vocalMixProject has explicit vocal, spatial, and mix buses", () => {
  assert.deepEqual(vocalMixProject.tracks.map((track) => track.name), [
    "BEAT",
    "LEAD VOCAL",
    "DOUBLES",
    "ADLIBS",
    "VOCAL BUS",
    "REV SHORT",
    "REV LONG",
    "DELAY",
    "MIX BUS",
  ]);
  assert.ok(vocalMixProject.sends.some((send) => send.from === "LEAD VOCAL" && send.to === "VOCAL BUS"));
  assert.ok(vocalMixProject.sends.some((send) => send.from === "VOCAL BUS" && send.to === "MIX BUS"));
  assert.equal(effectChainTemplates.filter((template) => template.scope === "vocal").length, 3);
  assert.equal(effectChainTemplates.filter((template) => template.scope === "master").length, 2);
  const lead = vocalMixProject.tracks.find((track) => track.name === "LEAD VOCAL");
  assert.deepEqual(lead?.effects.find((effect) => effect.plugin === "ReaComp (Cockos)")?.normalizedParameters, {
    "0": 0.125,
  });
  assert.deepEqual(lead?.effects.find((effect) => effect.plugin === "ReaXcomp (Cockos)")?.normalizedParameters, {
    "38": 0.1,
    "44": 0,
  });
  for (const name of ["REV SHORT", "REV LONG", "DELAY"]) {
    const track = vocalMixProject.tracks.find((candidate) => candidate.name === name);
    assert.ok(track?.effects.length);
    assert.equal(track.effects[0]?.wetOnly, true);
  }
});

test("every effect stage explains its job and has a fallback", () => {
  for (const template of effectChainTemplates) {
    for (const stage of template.stages) {
      assert.ok(stage.purpose.length > 0);
      assert.ok(stage.plugins.length > 0);
    }
  }
});
