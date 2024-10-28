# IdleMMO-Market-Helper
Intercepts API requests on the market and stores data, then displays profit/hr on skill pages.

This script **does not** make any requests of its own, and does not automate in-game actions in any way.
It's about the equivelent of making a spreadsheet to figure out which action is currently most profitable.

## How it works

This script overwrites the default browser behavior for `fetch()` XHR requests.  When it sees data
from the market, it stores item names and prices into the browser's IndexedDB database.  This means
to have accurate information, you must browse to the marketplace and look through the items you 
care about (eg: miner? filter by ore to ensure all ores are up to date).  If the result list is long,
be sure to scroll to the bottom to ensure all items are loaded.

When you view a skill page, a new element will appear next to each skill showing profit/hr. This is based
on the displayed speed, which includes any bonuses, and includes input item costs (such as alchemy or
cooking).

If *any* item in the recipe has an unknown price, the profit/hr will not render. This is by design.

One improvement to consider is to store the last update time for item pricing, and either flag outdated
ones, or act like there is no price at all. Right now stale entries are not detected.

## Disclaimer

The developer of IdleMMO has an incredibly aggressive track record toward banning users for little reason.
As an example, one user complained about how wearing "mercury armor" and "uranium armor" couldn't
possibly be a thing. The developer agreed, and this user created a userscript that just replaced the
names of the items.  This user was subsequently banned for changing the display names of items, despite
this not being against the TOS.

So all that said, if you use this userscript, don't tell anyone.  I doubt it's detectable on its own,
but if your behavior suddenly includes scrolling through every item on the market every 20 minutes,
you might get banned even with no evidence.
