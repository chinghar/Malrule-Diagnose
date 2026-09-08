"use client";

import { useMemo, useState } from "react";
import { diagnose, DEFAULT_SLIP_RATE } from "@/lib/diagnose/diagnose";
import type { Observation, ProblemInstance } from "@/lib/diagnose/types";
import { posteriorFromScores, selectNextInstance, uniformPosterior } from "@/lib/select/select";
import { allCategories } from "@/lib/data/loadIndex";

const CATEGORIES = allCategories();

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function pickInitialInstance(category: (typeof CATEGORIES)[number]): ProblemInstance {
  const posterior = uniformPosterior(category.malrules);
  const best = selectNextInstance(posterior, category.instances);
  return category.instances.find((i) => i.instance_id === best?.instanceId) ?? category.instances[0]!;
}

export default function DiagnosisApp() {
  const [categoryName, setCategoryName] = useState(CATEGORIES[0]!.category);
  const category = useMemo(() => CATEGORIES.find((c) => c.category === categoryName)!, [categoryName]);

  const [observations, setObservations] = useState<Observation[]>([]);
  const [currentInstanceId, setCurrentInstanceId] = useState<string>(() => pickInitialInstance(category).instance_id);
  const [answerInput, setAnswerInput] = useState("");
  const [slipRate, setSlipRate] = useState(DEFAULT_SLIP_RATE);

  const currentInstance = category.instances.find((i) => i.instance_id === currentInstanceId);

  const result = useMemo(
    () => (observations.length > 0 ? diagnose(observations, category.instances, category.malrules, slipRate) : null),
    [observations, category, slipRate]
  );

  function resetTo(nextCategoryName: string) {
    const nextCategory = CATEGORIES.find((c) => c.category === nextCategoryName)!;
    setCategoryName(nextCategoryName);
    setObservations([]);
    setCurrentInstanceId(pickInitialInstance(nextCategory).instance_id);
    setAnswerInput("");
  }

  function submitAnswer() {
    if (!currentInstance || answerInput.trim() === "") return;

    const nextObservations = [...observations, { instanceId: currentInstance.instance_id, studentAnswer: answerInput.trim() }];
    setObservations(nextObservations);
    setAnswerInput("");

    const usedIds = new Set(nextObservations.map((o) => o.instanceId));
    const nextResult = diagnose(nextObservations, category.instances, category.malrules, slipRate);
    const posterior =
      nextResult.ranked.length > 0 ? posteriorFromScores(nextResult.ranked) : uniformPosterior(category.malrules);
    const pool = category.instances.filter((i) => !usedIds.has(i.instance_id));
    const best = selectNextInstance(posterior, pool);
    const nextInstance = pool.find((i) => i.instance_id === best?.instanceId) ?? pool[0];
    if (nextInstance) setCurrentInstanceId(nextInstance.instance_id);
  }

  const leader = result?.ranked[0];
  const leaderMeta = leader ? category.malrules.find((m) => m.id === leader.malruleId) : undefined;
  const leaderExample = leader ? observations.find((o) => currentInstanceForObs(category, o.instanceId)?.predictions[leader.malruleId] !== undefined) : undefined;
  const leaderExampleInstance = leaderExample ? currentInstanceForObs(category, leaderExample.instanceId) : undefined;

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">malrule-diagnose</h1>
        <p className="mt-1 text-sm text-neutral-600">
          Deterministic malrule diagnosis from a child&apos;s arithmetic answers. Evaluated only on
          MalruleLib-generated synthetic data &mdash; real children&apos;s work is noisier. See the README.
        </p>
      </header>

      <section className="mb-8">
        <label className="mb-2 block text-sm font-medium text-neutral-700">Category</label>
        <div className="flex flex-wrap gap-2">
          {CATEGORIES.map((c) => (
            <button
              key={c.category}
              onClick={() => resetTo(c.category)}
              className={`rounded-full border px-3 py-1.5 text-sm transition ${
                c.category === categoryName
                  ? "border-neutral-900 bg-neutral-900 text-white"
                  : "border-neutral-300 bg-white text-neutral-700 hover:border-neutral-400"
              }`}
            >
              {c.category.replace(/_/g, " ")} ({c.malrules.length})
            </button>
          ))}
        </div>
      </section>

      {currentInstance && (
        <section className="mb-8 rounded-lg border border-neutral-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-medium text-neutral-500">
            {observations.length === 0 ? "First problem" : "Suggested next problem"}
            <span className="ml-1 font-normal text-neutral-400">
              (chosen to best distinguish the malrules still under consideration)
            </span>
          </h2>
          <p className="mt-2 text-lg font-medium">{currentInstance.problem_text}</p>
          <p className="mt-1 text-sm text-neutral-500">Correct answer: {currentInstance.correct_answer}</p>

          <div className="mt-4 flex gap-2">
            <input
              type="text"
              value={answerInput}
              onChange={(e) => setAnswerInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitAnswer();
              }}
              placeholder="Child's answer"
              className="w-40 rounded-md border border-neutral-300 px-3 py-1.5 text-sm focus:border-neutral-500 focus:outline-none"
            />
            <button
              onClick={submitAnswer}
              disabled={answerInput.trim() === ""}
              className="rounded-md bg-neutral-900 px-4 py-1.5 text-sm text-white disabled:opacity-40"
            >
              Submit
            </button>
          </div>
        </section>
      )}

      <section className="mb-8">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-neutral-700">
            Observations ({observations.length})
          </h2>
          {observations.length > 0 && (
            <button onClick={() => resetTo(categoryName)} className="text-xs text-neutral-500 underline">
              Start over
            </button>
          )}
        </div>
        {observations.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">Submit an answer above to begin diagnosis.</p>
        ) : (
          <ul className="mt-2 space-y-1 text-sm">
            {observations.map((o, idx) => {
              const inst = currentInstanceForObs(category, o.instanceId);
              const correct = inst?.correct_answer === o.studentAnswer;
              return (
                <li key={`${o.instanceId}-${idx}`} className="flex items-center gap-2 text-neutral-600">
                  <span className={correct ? "text-emerald-600" : "text-neutral-400"}>{correct ? "✓" : "✗"}</span>
                  <span className="truncate">{inst?.problem_text}</span>
                  <span className="text-neutral-400">&rarr;</span>
                  <span className="font-medium text-neutral-800">{o.studentAnswer}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="mb-8">
        <label className="mb-1 block text-sm font-medium text-neutral-700">
          Assumed slip rate: {slipRate.toFixed(2)}
        </label>
        <p className="mb-2 text-xs text-neutral-500">
          Probability a child correctly executing a malrule still gives a different answer on any one
          problem (arithmetic error, copy error, lapse). Diagnosis scores answers by consistency under
          this rate, not by exact match.
        </p>
        <input
          type="range"
          min={0.05}
          max={0.35}
          step={0.01}
          value={slipRate}
          onChange={(e) => setSlipRate(Number(e.target.value))}
          className="w-full max-w-xs"
        />
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-sm font-medium text-neutral-700">Posterior over malrules</h2>
        {!result ? (
          <p className="text-sm text-neutral-500">No observations yet.</p>
        ) : result.noPatternDetected ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
            No systematic pattern detected. The answers so far don&apos;t match any known malrule better
            than chance &mdash; this may just be random error rather than a consistent procedure.
          </div>
        ) : null}

        {result && result.tiedTop.length > 1 && (
          <div className="mt-2 rounded-md border border-blue-300 bg-blue-50 p-3 text-sm text-blue-800">
            {result.tiedTop.length} malrules are indistinguishable given the observations so far:{" "}
            {result.tiedTop.join(", ")}. Answer the suggested problem above to help tell them apart.
          </div>
        )}

        {result && result.ranked.length > 0 && (
          <ul className="mt-3 divide-y divide-neutral-200 rounded-lg border border-neutral-200 bg-white">
            {result.ranked.map((r, idx) => {
              const meta = category.malrules.find((m) => m.id === r.malruleId);
              return (
                <li key={r.malruleId} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="w-5 text-sm text-neutral-400">{idx + 1}</span>
                  <div className="flex-1">
                    <div className="text-sm font-medium text-neutral-900">{meta?.name ?? r.malruleId}</div>
                    <div className="text-xs text-neutral-500">
                      {r.matches}/{r.applicable} observations match
                      {result.tiedTop.includes(r.malruleId) && result.tiedTop.length > 1 ? " · tied for lead" : ""}
                    </div>
                  </div>
                  <div className="w-32">
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-100">
                      <div
                        className="h-full rounded-full bg-neutral-800"
                        style={{ width: `${Math.max(2, r.posterior * 100)}%` }}
                      />
                    </div>
                    <div className="mt-1 text-right text-xs text-neutral-500">{pct(r.posterior)}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {result && result.untested.length > 0 && (
          <p className="mt-2 text-xs text-neutral-400">
            {result.untested.length} other malrule{result.untested.length === 1 ? "" : "s"} in this category
            could not be evaluated on the problems given so far (not applicable to that problem shape) and
            are neither ruled in nor out.
          </p>
        )}
      </section>

      {leader && leaderMeta && !result?.noPatternDetected && (
        <section className="rounded-lg border border-neutral-200 bg-neutral-50 p-5">
          <h2 className="text-sm font-medium text-neutral-700">
            Leading malrule{result && result.tiedTop.length > 1 ? " (tied)" : ""}: {leaderMeta.name}
          </h2>
          <p className="mt-2 text-sm text-neutral-700">{leaderMeta.description}</p>
          {leaderExampleInstance && (
            <div className="mt-3 rounded-md bg-white p-3 text-sm">
              <p className="text-neutral-500">Worked example, applying this procedure to a problem asked:</p>
              <p className="mt-1 font-medium">{leaderExampleInstance.problem_text}</p>
              <p className="mt-1 text-neutral-600">
                Correct answer: <span className="font-medium text-neutral-900">{leaderExampleInstance.correct_answer}</span>
                {" · "}
                {leaderMeta.name} predicts:{" "}
                <span className="font-medium text-neutral-900">
                  {leaderExampleInstance.predictions[leader.malruleId]}
                </span>
              </p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function currentInstanceForObs(category: (typeof CATEGORIES)[number], instanceId: string): ProblemInstance | undefined {
  return category.instances.find((i) => i.instance_id === instanceId);
}
