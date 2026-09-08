#!/usr/bin/env python3
"""
Offline precompute (runs once, on the developer's machine, never at request
time). For the v1 scope categories, generate problem instances using each
malrule's own MalruleLib problem_generator, then run every malrule in that
category's malrule_algorithm against every instance.

Malrule algorithms are only guaranteed compatible with problems produced by
their own generator (verified empirically: cross-malrule compatibility rates
range from 27% in fractions to 86% in subtraction, because malrules in the
same category can represent genuinely different problem shapes, e.g.
fraction addition vs fraction ordering vs fraction division). When a
malrule's algorithm cannot run on a given instance (raises an exception), it
is simply omitted from that instance's `predictions` map -- it is not
applicable to that problem shape, not a wrong answer. This is a real,
reportable property of the library, not a bug to paper over.

Does not modify vendor/malrulelib. Writes only to data/index/.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "vendor" / "malrulelib"
OUT_DIR = ROOT / "data" / "index"

sys.path.insert(0, str(VENDOR))
from utils import DifficultyLevel  # noqa: E402
import datagen  # noqa: E402  (vendor's own malrule discovery/loading glue)

CATEGORIES = ["subtraction", "fractions", "decimals", "multiplication_division"]
INSTANCES_PER_MALRULE = 80
BASE_SEED = 20260908
LEVEL = 5
DIFFICULTY = DifficultyLevel.MEDIUM


def load_category_malrules(category):
    all_malrules = datagen.discover_malrules()
    cat_malrules = sorted(
        (name, module_path) for c, name, module_path in all_malrules if c == category
    )

    loaded = {}
    for name, module_path in cat_malrules:
        gen_cls, mal_cls, correct_cls = datagen.load_malrule_classes(module_path)
        if not all([gen_cls, mal_cls, correct_cls]):
            print(f"  SKIP {category}.{name}: could not load generator/malrule/correct classes")
            continue
        loaded[name] = {
            "id": f"{category}.{name}",
            "gen_cls": gen_cls,
            "mal_instance": mal_cls(),
            "correct_instance": correct_cls(),
        }
    return loaded


def build_category(category):
    loaded = load_category_malrules(category)

    malrule_meta = {}
    for info in loaded.values():
        m = info["mal_instance"]
        malrule_meta[info["id"]] = {
            "id": info["id"],
            "category": category,
            "name": m.get_name(),
            "description": m.get_description(),
        }

    instances = []
    stats = {"generated": 0, "kept": 0, "cross_attempts": 0, "cross_ok": 0}

    for idx, (name, info) in enumerate(sorted(loaded.items())):
        native_id = info["id"]
        generator = info["gen_cls"](level=LEVEL, difficulty=DIFFICULTY)

        seen_texts = set()
        n_kept = 0
        attempt = 0
        max_attempts = INSTANCES_PER_MALRULE * 6

        while n_kept < INSTANCES_PER_MALRULE and attempt < max_attempts:
            seed = BASE_SEED + idx * 100000 + attempt
            attempt += 1

            try:
                problem = generator.generate(seed=seed)
            except Exception:
                continue
            stats["generated"] += 1

            if problem.text in seen_texts:
                continue

            try:
                correct_answer = str(info["correct_instance"].solve(problem).answer)
                native_answer = str(info["mal_instance"].solve(problem).answer)
            except Exception:
                continue

            # A problem instance where the malrule happens to agree with the
            # correct answer carries no diagnostic signal for this malrule.
            if native_answer == correct_answer:
                continue

            seen_texts.add(problem.text)

            predictions = {native_id: native_answer}
            for other_name, other_info in loaded.items():
                if other_name == name:
                    continue
                stats["cross_attempts"] += 1
                try:
                    other_answer = str(other_info["mal_instance"].solve(problem).answer)
                    predictions[other_info["id"]] = other_answer
                    stats["cross_ok"] += 1
                except Exception:
                    pass  # not applicable: this malrule's algorithm can't run on this problem shape

            instances.append({
                "instance_id": f"{native_id}#{n_kept:04d}",
                "native_malrule_id": native_id,
                "template": (problem.metadata or {}).get("template", "default"),
                "problem_text": problem.text,
                "operation": problem.operation,
                "correct_answer": correct_answer,
                "predictions": predictions,
            })
            n_kept += 1

        stats["kept"] += n_kept
        print(f"  {native_id}: kept {n_kept}/{INSTANCES_PER_MALRULE} (from {attempt} generation attempts)")

    return malrule_meta, instances, stats


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest = {"categories": {}}
    total_malrules = 0
    total_instances = 0

    for category in CATEGORIES:
        print(f"\n=== {category} ===")
        malrule_meta, instances, stats = build_category(category)

        out = {
            "category": category,
            "malrules": list(malrule_meta.values()),
            "instances": instances,
        }
        out_path = OUT_DIR / f"{category}.json"
        out_path.write_text(json.dumps(out, separators=(",", ":")))

        cross_rate = (stats["cross_ok"] / stats["cross_attempts"]) if stats["cross_attempts"] else 0.0
        manifest["categories"][category] = {
            "malrule_count": len(malrule_meta),
            "instance_count": len(instances),
            "cross_applicability_rate": round(cross_rate, 4),
            "file": f"{category}.json",
            "size_bytes": out_path.stat().st_size,
        }
        total_malrules += len(malrule_meta)
        total_instances += len(instances)
        print(f"  -> {len(instances)} instances, {len(malrule_meta)} malrules, "
              f"cross-applicability {cross_rate:.1%}, {out_path.stat().st_size} bytes")

    manifest["total_malrules"] = total_malrules
    manifest["total_instances"] = total_instances
    manifest_path = OUT_DIR / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2))

    print(f"\n{'='*70}")
    print(f"TOTAL: {total_malrules} malrules, {total_instances} instances")
    total_size = sum(c["size_bytes"] for c in manifest["categories"].values()) + manifest_path.stat().st_size
    print(f"Index size on disk: {total_size / 1024:.1f} KB")
    print(f"Manifest: {manifest_path}")


if __name__ == "__main__":
    main()
