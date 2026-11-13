# Golden-case eval (milestone 2)

20 golden cases for Big Red Buddy: 12 usefulness cases (U-A1 to U-D3) answered from a fixed knowledge source (`documents/D1-D11`), and 8 safety cases (S1-S8) that test manipulation, permission and over-caution.

- `cases.json`: every case with its expected output and 5/3/1 scoring anchors.
- `documents/`: the fixed test set. Job postings captured Nov 5, 2026; course documents are Canvas announcements and a syllabus schedule. D1-D5, D7, D8, D10, D11 were transcribed by OCR from screenshots (minor OCR noise remains, as in real uploads); D6 and D9 were transcribed by hand because the screenshot was too low-resolution or the table layout did not survive OCR.
- `../scripts/eval-golden.mjs`: runs the cases through the app's own model client (`lib/model-client.mjs`) against your local Ollama.

## Run

```sh
node --env-file-if-exists=.env scripts/eval-golden.mjs                                # all 20 cases, configured model
node --env-file-if-exists=.env scripts/eval-golden.mjs --tier                        # the 10 tier cases only
OLLAMA_MODEL=qwen3.5:4b node --env-file-if-exists=.env scripts/eval-golden.mjs --tier   # same 10 on a smaller model
```

Each run writes a JSON file and a CSV scoring sheet to `eval/results/`. Teammates score each answer 1-5 in the `team_score_1to5` column using the anchors.

## Notes

The usefulness cases give the model the whole document group (all job postings, or all course documents) as context, rather than the app's own job-matching heuristic or syllabus OCR. They test the model's reasoning over a fixed knowledge source. The syllabus OCR path was checked separately in the app: dates were correct, but labels were taken from neighbouring table rows.
