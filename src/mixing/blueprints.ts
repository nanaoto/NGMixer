export interface ProjectTrack {
  readonly name: string;
  readonly role: "source" | "vocal" | "bus" | "return";
  readonly color: string;
  readonly effects: readonly ProjectEffect[];
}

export interface ProjectEffect {
  readonly plugin: string;
  readonly wetOnly?: boolean;
  readonly normalizedParameters?: Readonly<Record<string, number>>;
}

export interface ProjectSend {
  readonly from: string;
  readonly to: string;
  readonly gainDb: number;
}

export interface ProjectBlueprint {
  readonly id: string;
  readonly sampleRate: 48_000;
  readonly tracks: readonly ProjectTrack[];
  readonly sends: readonly ProjectSend[];
}

export const vocalMixProject: ProjectBlueprint = {
  id: "vocal-mix-48k-v1",
  sampleRate: 48_000,
  tracks: [
    { name: "BEAT", role: "source", color: "#4f77c7", effects: [] },
    { name: "LEAD VOCAL", role: "vocal", color: "#e35d6a", effects: [
      { plugin: "ReaEQ (Cockos)" },
      { plugin: "ReaComp (Cockos)", normalizedParameters: { "0": 0.125 } },
      { plugin: "ReaXcomp (Cockos)", normalizedParameters: { "38": 0.1, "44": 0 } },
    ] },
    { name: "DOUBLES", role: "vocal", color: "#dc8a49", effects: [
      { plugin: "ReaEQ (Cockos)" },
      { plugin: "ReaComp (Cockos)" },
    ] },
    { name: "ADLIBS", role: "vocal", color: "#c86bcb", effects: [
      { plugin: "ReaEQ (Cockos)" },
      { plugin: "ReaComp (Cockos)" },
    ] },
    { name: "VOCAL BUS", role: "bus", color: "#e1ae45", effects: [
      { plugin: "ReaEQ (Cockos)" },
      { plugin: "ReaComp (Cockos)" },
    ] },
    { name: "REV SHORT", role: "return", color: "#57a99a", effects: [
      { plugin: "ReaVerbate (Cockos)", wetOnly: true, normalizedParameters: { "0": 0.25, "1": 0.6, "2": 0.8 } },
    ] },
    { name: "REV LONG", role: "return", color: "#4e9b76", effects: [
      { plugin: "ReaVerbate (Cockos)", wetOnly: true, normalizedParameters: { "0": 0.75, "1": 0.45, "2": 1 } },
    ] },
    { name: "DELAY", role: "return", color: "#5baac9", effects: [
      { plugin: "ReaDelay (Cockos)", wetOnly: true },
    ] },
    { name: "MIX BUS", role: "bus", color: "#9b8bd4", effects: [
      { plugin: "ReaEQ (Cockos)" },
      { plugin: "ReaComp (Cockos)" },
      { plugin: "ReaLimit (Cockos)" },
    ] },
  ],
  sends: [
    { from: "LEAD VOCAL", to: "VOCAL BUS", gainDb: 0 },
    { from: "DOUBLES", to: "VOCAL BUS", gainDb: 0 },
    { from: "ADLIBS", to: "VOCAL BUS", gainDb: 0 },
    { from: "VOCAL BUS", to: "MIX BUS", gainDb: 0 },
    { from: "BEAT", to: "MIX BUS", gainDb: 0 },
    { from: "REV SHORT", to: "MIX BUS", gainDb: 0 },
    { from: "REV LONG", to: "MIX BUS", gainDb: 0 },
    { from: "DELAY", to: "MIX BUS", gainDb: 0 },
    { from: "LEAD VOCAL", to: "REV SHORT", gainDb: -18 },
    { from: "LEAD VOCAL", to: "REV LONG", gainDb: -24 },
    { from: "LEAD VOCAL", to: "DELAY", gainDb: -21 },
    { from: "DOUBLES", to: "REV SHORT", gainDb: -18 },
    { from: "ADLIBS", to: "DELAY", gainDb: -18 },
  ],
};

export interface EffectStage {
  readonly id: string;
  readonly purpose: string;
  readonly plugins: readonly string[];
  readonly startingPoint: Readonly<Record<string, string | number | boolean>>;
}

export interface EffectChainTemplate {
  readonly id: string;
  readonly name: string;
  readonly scope: "vocal" | "master";
  readonly intent: string;
  readonly stages: readonly EffectStage[];
}

const vocalCleanup: readonly EffectStage[] = [
  { id: "cleanup-eq", purpose: "去直流、隆隆声和明显共振；只处理听见的问题", plugins: ["FabFilter Pro-Q 4", "ReaEQ (Cockos)"], startingPoint: { highPassHz: 70, dynamicNotches: "listen-first" } },
  { id: "main-compression", purpose: "稳定字头和句间落差，让主唱站稳而不压扁", plugins: ["FabFilter Pro-C 2", "ReaComp (Cockos)"], startingPoint: { ratio: "2:1–4:1", gainReductionDb: "3–6" } },
  { id: "de-ess", purpose: "压住齿音，不把整段高频削暗", plugins: ["FabFilter Pro-DS", "SPL De-Esser Dual-Band", "ReaXcomp (Cockos)"], startingPoint: { mode: "single-vocal", rangeDb: "3–6", audition: true } },
];

export const effectChainTemplates: readonly EffectChainTemplate[] = [
  {
    id: "vocal-clean-pop-v1",
    name: "清晰流行主唱",
    scope: "vocal",
    intent: "靠前、干净、明亮，但保留自然动态",
    stages: [...vocalCleanup,
      { id: "tone", purpose: "压缩后补存在感和空气感", plugins: ["FabFilter Pro-Q 4", "Maag EQ4", "ReaEQ (Cockos)"], startingPoint: { presence: "small broad boost", air: "optional" } },
      { id: "density", purpose: "轻微谐波增加可闻度，不靠硬削峰制造响度", plugins: ["FabFilter Saturn 2", "Black Box Analog Design HG-2", "JS: Saturation"], startingPoint: { mixPercent: "5–15" } },
    ],
  },
  {
    id: "vocal-intimate-rap-v1",
    name: "贴脸说唱主唱",
    scope: "vocal",
    intent: "近、密、字头清楚，空间短而可控",
    stages: [...vocalCleanup,
      { id: "fast-control", purpose: "第二级快速控制尖峰，保留第一层主体动态", plugins: ["FabFilter Pro-C 2", "Kiive XTComp", "ReaComp (Cockos)"], startingPoint: { gainReductionDb: "1–3", attack: "fast" } },
      { id: "edge", purpose: "增加中频密度与咬字感", plugins: ["FabFilter Saturn 2", "NEOLD BIG AL", "JS: Saturation"], startingPoint: { drive: "low", mixPercent: "5–12" } },
    ],
  },
  {
    id: "vocal-stock-portable-v1",
    name: "REAPER 原生可移植主唱",
    scope: "vocal",
    intent: "换机器也能打开和继续调整",
    stages: vocalCleanup.map((stage) => ({ ...stage, plugins: stage.plugins.filter((plugin) => plugin.includes("Rea")) })),
  },
  {
    id: "master-transparent-v1",
    name: "透明流媒体母带",
    scope: "master",
    intent: "电平匹配下不牺牲瞬态，控制真峰值",
    stages: [
      { id: "reference", purpose: "与同风格参考曲做等响度 A/B", plugins: ["ADPTR MetricAB", "Ozone 11", "JS: Loudness Meter Peak/RMS/LUFS"], startingPoint: { gainMatched: true } },
      { id: "corrective-eq", purpose: "只修整体频谱失衡", plugins: ["FabFilter Pro-Q 4", "Ozone 11 Equalizer", "ReaEQ (Cockos)"], startingPoint: { movesDb: "usually < 1.5" } },
      { id: "glue", purpose: "需要时轻微粘合，不把混音重新压一遍", plugins: ["FabFilter Pro-C 2", "AMEK Mastering Compressor", "ReaComp (Cockos)"], startingPoint: { gainReductionDb: "0–2" } },
      { id: "limiter", purpose: "达到交付响度并控制编码后的真峰值", plugins: ["FabFilter Pro-L 2", "Ozone 11 Maximizer", "ReaLimit (Cockos)"], startingPoint: { truePeak: true, ceilingDbTp: -1, oversampling: "4x", loudness: "genre/reference-led" } },
    ],
  },
  {
    id: "master-loud-modern-v1",
    name: "现代高密度母带",
    scope: "master",
    intent: "在失真和瞬态可接受的前提下增加密度，不追固定数字",
    stages: [
      { id: "tone", purpose: "先修低频与刺耳区，避免后级被问题频段驱动", plugins: ["FabFilter Pro-Q 4", "Ozone 11 Dynamic EQ"], startingPoint: { dynamic: true, movesDb: "small" } },
      { id: "clip-density", purpose: "分担限制器峰值压力", plugins: ["bx_clipper", "Ozone 11 Maximizer"], startingPoint: { shaveDb: "0–2" } },
      { id: "limiter", purpose: "最终响度与真峰值验收", plugins: ["FabFilter Pro-L 2", "Ozone 11 Maximizer"], startingPoint: { truePeak: true, ceilingDbTp: -1, compareAtEqualLoudness: true } },
    ],
  },
];
