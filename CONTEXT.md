# Prewalk domain language

## Pi session

A Pi session is one Pi conversation identified by one session ID.

## Task tree

A task tree is a Pi session together with the delegated descendant sessions
attributable to it.

## Current-session snapshot

A current-session snapshot is the observed data for the exact current Pi session
at the time the snapshot is requested. It does not include descendant sessions.

## Terminal run

A terminal run is a Prewalk run that has a completed receipt.

## Active run

An active run is a Prewalk run that has started but does not yet have a terminal
receipt.

## Observed spend

Observed spend is cost attributed by Pi to recorded usage. It is distinct from
a counterfactual estimate.
