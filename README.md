# Outfit Viewer

A SillyTavern extension that shows an outfit image in a panel to the right of the chat. It switches automatically when an outfit's name is mentioned, and you can pick one by hand at any time. It isn't tied to any character card.

## Setup

**Recommended: a SillyTavern image folder.** It's remembered across reloads in every browser.

1. Put the images in `SillyTavern/data/default-user/user/images/<folder>/`. To keep them somewhere else, link that folder there instead. On Windows (PowerShell):
   `New-Item -ItemType Junction -Path "...\SillyTavern\data\default-user\user\images\outfits" -Target "C:\path\to\your\outfits"`
2. The viewer loads `user/images/outfits` by default. To use a different folder, go to Extensions → Outfit Viewer, type its name and click **Load**.

**Alternative: a folder picked from your computer.** Click **Choose outfit folder**. Only Chrome and Edge can remember it; Brave (which turns that browser feature off) and Firefox ask again after every reload.

## Outfit names

- An image's outfit name is its filename without the extension: `Witch.png` → "Witch".
- Several keys can share one image, separated by commas: `Fluffy witch, Paw witch.png` is listed with both keys in the dropdown and switches on either phrase.
- Files still carrying an image generator's long automatic name (containing "masterpiece", or starting with a long number) are named from the prompt stored in the PNG instead. The first word or two after the style tags becomes the name, e.g. `**Witch <weight[1.1]:cosplay>.**` → "Witch".
- If two images end up with the same name, the second becomes "Name 2", and so on. Rename a file to give it a proper name.

## Switching

- Whenever a message mentions an outfit name as a whole word (case-insensitive), the panel switches to it. If several are mentioned, the last one wins, and longer names beat shorter ones at the same spot, so "Fluffy witch" beats "witch".
- The dropdown at the top of the panel picks an outfit by hand.
- Under the image, a text box shows the outfit's description: the text after the `**title**` in the prompt saved inside the PNG. It can be turned off in the settings.
- The ↻ button re-reads the folder, picking up renamed, added or replaced images without reloading the page.
- With the mouse over the panel, the scroll wheel or the left/right arrow keys flip to the previous/next outfit.
- Drag the panel by its header (the grip icon) to move it; double-click the header to put it back in the top-right corner.
- `/outfit Name` shows an outfit; `/outfit` with no name clears it.
- The current outfit is saved per chat.
