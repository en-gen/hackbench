### Changed

- Maps tree (#949): a slot with no usable pointer shows as "New" (counted apart in the Unassigned label, only when there are any) and opens an empty view with a one-line note. Slots that share the most common pointer are ordinary Unassigned maps: no "placeholder" label or tooltip, counted with the maps (vanilla: 512 maps), and a group can take them. A map whose level data has no end marker within 128 KB now warns on its row (a hack's custom objects can hide a fault this cannot see). Glossary and map-data docs updated to match.
