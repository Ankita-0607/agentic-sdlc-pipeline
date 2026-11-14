# Turnaround time should not count time spent on hold

Samples go `on_hold` when we are waiting on the client (a missing consent form,
not enough material). That waiting time currently counts against our
turnaround numbers, which makes our SLA reporting look worse than our actual
lab performance.

## Expected behaviour

`turnaroundHours` in `src/turnaround.ts` should subtract every on-hold interval
between the `received` event and the `reported` event. An on-hold interval runs
from an `on_hold` event to the next event in the sample's history.

Example: received 1 March 08:00, on hold 1 March 12:00, sequencing resumes
1 March 18:00 (a 6 hour hold), reported 3 March 08:00. Turnaround is 42 hours,
not 48.

- A sample with several holds has all of them subtracted.
- A sample with no holds is unchanged.
- A sample that has not been reported still returns `null`.
