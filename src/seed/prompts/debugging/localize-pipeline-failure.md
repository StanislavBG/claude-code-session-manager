---
id: debugging/localize-pipeline-failure
title: Localize the failure in a long pipeline
category: Debugging
sendMode: paste
description: Halves the pipeline at midpoints to localize the bug to one transform; outputs a bisection log.
---
The pipeline [name it] produces wrong output at the end. Halve the pipeline: log or assert intermediate state at the midpoint and determine whether the bug is upstream or downstream of that midpoint. Recurse until the bug localizes to a single function or transform. Output the bisection log as a list of `checkpoint → state observed → conclusion`. Once localized, diagnose the specific function and propose a patch.
