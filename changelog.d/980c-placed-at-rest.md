### Changed

- Map view: each sprite is drawn at the position in the map's sprite list by its own draw code, without running its start-up code first; start-up moves and looks are left for play/simulate. Sprites that draw nothing without start-up code show the not-drawn marker (#980).
