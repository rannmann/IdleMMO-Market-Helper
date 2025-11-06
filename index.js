// ==UserScript==
// @name         IdleMMO Market Data Helper
// @namespace    web-idle-mmo-market-helper
// @version      0.3
// @description  Intercepts API requests on the market and stores data into a local database, then displays profit/hr on skill pages.
// @author       rannmann
// @match        https://web.idle-mmo.com/*
// @run-at       document-start
// @icon         data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==
// @grant        GM_log
// ==/UserScript==

(function() {
    'use strict';

    /** Global Vars */
    // Open (or create) the database
    const request = indexedDB.open('MarketDatabase', 1);
    let db = null;
    const stalledXHR = [];
    let currentPage = null;

    /** Start */
    main();

    /** Logic */
    function main() {
        interceptXHR();
        registerDatabase();
        setCurrentPage();
        // We need to wait for Alpine to render the page. This should probably be adjusted.
        setTimeout(renderPage, 1000);
    }

    /**
     * Sets up the IndexedDB for storing market data.
     *
     * - Creates or upgrades the 'items' object store with indexes on 'hashed_id' and 'name'.
     * - Processes stalled XHR data once the database is ready.
     * - Logs errors on connection failure.
     */
    function registerDatabase() {
        request.onupgradeneeded = function(event) {
            const db = event.target.result;
            console.debug('Upgrading database...');

            if (!db.objectStoreNames.contains('items')) {
                const objectStore = db.createObjectStore('items', { keyPath: 'id' });
                objectStore.createIndex('name', 'name', { unique: false });
                console.debug('Created object store "items".');
            }
        };

        request.onsuccess = function(event) {
            db = event.target.result;
            console.debug('Database connection established.');

            // Process any stalled XHR data now that the DB is ready
            while (stalledXHR.length > 0) {
                const data = stalledXHR.pop();
                storeItemsIndexedDB(data);
            }
        };

        request.onerror = function(event) {
            console.error('IndexedDB error:', event.target.errorCode);
        };
    }

    /**
     * Intercepts XMLHttpRequests and fetch calls to log and process market data.
     *
     * - Overrides the native fetch function to capture request and response details.
     * - Dispatches a custom event with the fetched data for further processing.
     * - Listens for the custom event to handle the intercepted data.
     */
    function interceptXHR() {
        const overrideFetch = `
            (function() {
                const originalFetch = window.fetch;
                window.fetch = async function(...args) {
                    const [resource, config] = args;

                    //console.debug('Intercepted fetch request:', resource, config);

                    // Run the original request normally
                    const response = await originalFetch.apply(this, args);

                    // Clone the response to read its data without affecting the original response
                    const clonedResponse = response.clone();

                    // Attempt to parse the response as JSON
                    try {
                        const data = await clonedResponse.json();
                        //console.debug('Intercepted fetch response data:', data);

                        // Dispatch a custom event with the fetched data
                        window.dispatchEvent(new CustomEvent('fetchIntercepted', { detail: { resource, config, data } }));
                    } catch (error) {
                        console.warn('Fetch response is not JSON:', error);
                    }

                    return response;
                };
            })();
        `;

        // Inject the overrideFetch script into the page
        const script = document.createElement('script');
        script.textContent = overrideFetch;
        document.documentElement.appendChild(script);
        script.remove();

        // Listen for the custom event to react to fetched data
        window.addEventListener('fetchIntercepted', function(event) {
            const { resource, config, data } = event.detail;

            // Your custom logic to handle the fetched data
            console.debug('Userscript received fetched data:', data);

            // Take action based on the resource URL
            if (resource.includes('/api/market/items')) {
                console.debug('Found market API request, trying to parse');
                storeItemsIndexedDB(data.data);
            }
        });
    }

    /**
     * Stores market items data into IndexedDB.
     *
     * Each item is stored in the 'items' object store within a transaction. The function
     * filters out items with a tier greater than 1 to avoid overwriting tier 1 prices,
     * as the data is keyed by item ID.
     *
     * @param {Array} data - An array of item objects to be stored. Each item object should
     *                       contain the following properties:
     *                       - id: The unique identifier for the item.
     *                       - hashed_id: A hashed version of the item ID.
     *                       - price: An object containing the minimum price as a string.
     *                       - name: The name of the item.
     *                       - tier: The tier level of the item.
     */
    function storeItemsIndexedDB(data) {
        if (db === null) {
            stalledXHR.push(data);
            console.warn('Cannot store items: Not connected to database yet.')
            return;
        }

        if (stalledXHR.length !== 0) {
            // Deal with backlog first.
            console.debug('Stalled XHR length:' + stalledXHR.length);
            storeItemsIndexedDB(stalledXHR.pop());
        }

        console.debug('Trying to store', data, 'in database', db);

        const transaction = db.transaction(['items'], 'readwrite');
        const objectStore = transaction.objectStore('items');

        data.forEach(item => {
            if (item.tier !== null && item.tier > 1) {
                // We care more about craftable item prices, not upgrade prices.
                // So ignore higher tier items to avoid overwriting t1 prices,
                // since it's keyed by ID.
                return;
            }
            const itemData = {
                id: item.id,
                hashed_id: item.hashed_id,
                minimumPrice: typeof item.price.minimum === 'string'
                    ? parseInt(item.price.minimum.replace(/,/g, ''), 10)
                    : item.price.minimum,
                name: item.name,
                tier: item.tier,
            };
            objectStore.put(itemData);
        });

        transaction.oncomplete = function() {
            console.log('All items have been added to IndexedDB.');
        };

        transaction.onerror = function(event) {
            console.error('Transaction error:', event.target.error);
        };
    }

    function getItemByNameIndexedDB(name) {
        const vendorItem = findVendorItemByName(name);
        if (vendorItem) {
            // We probably just need minimumPrice but send some basic data anyway.
            return {
                name: vendorItem.name,
                id: vendorItem.id,
                minimumPrice: vendorItem.price
            }
        }

        return new Promise((resolve, reject) => {
            // Check if the item exists in vendorItems
            const vendorItem = findVendorItemByName(name);
            if (vendorItem) {
                resolve(vendorItem);
                return;
            }

            // Ensure the database is connected
            if (db === null) {
                console.error('Not connected to database yet.');
                reject(new Error('Database not connected.'));
                return;
            }

            // Begin a readonly transaction
            const transaction = db.transaction(['items'], 'readonly');
            const objectStore = transaction.objectStore('items');
            const index = objectStore.index('name');
            const getRequest = index.get(name);

            // Handle successful retrieval
            getRequest.onsuccess = function() {
                const item = getRequest.result;
                if (item) {
                    resolve(item);
                } else {
                    console.debug(`Item with name ${name} not found.`);
                    reject(new Error(`Item with name ${name} not found.`));
                }
            };

            // Handle errors during retrieval
            getRequest.onerror = function(event) {
                console.error('Get request error:', event.target.error);
                reject(event.target.error);
            };
        });
    }

    // Example usage:
    // After storing the data using storeItemsIndexedDB, retrieve an item:
    //getItemByNameIndexedDB('Goblin Totem');

    function setCurrentPage() {
        // Parse the URL to get the page:
        const url = new URL(window.location.href);
        const pathname = url.pathname;
        let pageName = pathname.split('/').filter(segment => segment).pop();

        if (pageName.startsWith('@')) {
            pageName = '@user';
        }

        console.log(`Current page name: ${pageName}`);

        currentPage = pageName;
    }

    function renderPage() {
        switch(currentPage) {
            case 'woodcutting':
            case 'mining':
            case 'fishing':
            case 'alchemy':
            case 'smelting':
            case 'cooking':
            //case 'forge': // UI is different here.
                renderCraftProfit();
                break;
            default:
                console.debug('No render actions for ' + currentPage);
        }
    }

    /**
     * Page Renders
     */

    async function renderCraftProfit() {
        console.debug("rendering alch profit...", db);
        // Select the list containing all recipe buttons
        const knownRecipesList = document.querySelector('ul.divide-y');
        console.log(knownRecipesList);
        if (!knownRecipesList) {
            console.error('Could not find the recipes list.');
            return;
        }

        // Select all buttons within the recipes list
        const recipeButtons = knownRecipesList.querySelectorAll('button > li');

        // Array to hold all extracted recipe data
        const recipesData = [];

        // Iterate over each recipe button
        for (const button of recipeButtons) {
            // Initialize an object to store the current recipe's data
            const recipe = {
                recipeName: '',
                recipeSellPrice: 0,
                recipeSellPriceWithTax: 0,
                craftTimeSeconds: 0,
                requirements: []
            };

            // Get required elements
            const nameSpan = button.querySelector('span[x-text="skill_item.name"]');
            const craftTimeSpan = button.querySelector('span[x-text="skill_item.wait_length"]');
            const requirementsContainer = button.querySelector('div.mt-1.flex');

            if (!nameSpan || !craftTimeSpan || !requirementsContainer) {
                // Must skip. Not enough data.
                continue;
            }

            recipe.recipeName = nameSpan.textContent.trim();
            recipe.craftTimeSeconds = parseFloat(craftTimeSpan.textContent.trim());

            if (recipe.recipeName === 'Cooked Cod') {
                // Cannot be sold.
                // TODO: Figure out how to do this...
                recipe.recipeSellPrice = 2;
                recipe.recipeSellPriceWithTax = 2;
            } else {
                const recipeItem = await getItemByNameIndexedDB(recipe.recipeName);
                console.log(recipeItem);
                recipe.recipeSellPrice = recipeItem.minimumPrice;
                // Tax is always rounded up.
                recipe.recipeSellPriceWithTax = Math.floor(recipe.recipeSellPrice * 0.88);
            }



            // Select all requirement spans within the container
            // Specifically target spans with x-text="requirement.quantity_requirement"
            const requirementSpans = requirementsContainer.querySelectorAll('span.rounded-md');

            await Promise.all(Array.from(requirementSpans).map(async requirementSpan => {                // Check if this span is a crafting requirement by looking for the specific x-text attribute
                const quantitySpan = requirementSpan.querySelector('span[x-text="requirement.quantity_requirement"]');
                const itemNameSpan = requirementSpan.querySelector('span[x-text="requirement.item.name"]');


                if (quantitySpan && itemNameSpan) {
                    // Extract data
                    const quantity = parseInt(quantitySpan.textContent.trim(), 10);
                    const itemName = itemNameSpan.textContent.trim();

                    if (!isNaN(quantity) && itemName) {
                        const itemData = await getItemByNameIndexedDB(itemName);
                        if (!itemData) {
                            // We cannot calculate this.
                            // Break the price on purpose.
                            recipe.recipeSellPrice = 0;
                            recipe.recipeSellPriceWithTax = 0;
                            return;
                        }

                        recipe.requirements.push({
                            quantity: quantity,
                            name: itemName,
                            spanElement: requirementSpan,
                            totalPrice: itemData.minimumPrice * quantity,
                        });
                    } else {
                        console.warn('Invalid quantity or item name in span:', requirementSpan);
                    }
                }
                // If the span does not match the requirement pattern, skip it without logging a warning
            }));


            // Calculate total profit per craft:
            let totalCost = 0;
            recipe.requirements.forEach(req => {
                totalCost += req.totalPrice;
            });
            const totalProfit = recipe.recipeSellPriceWithTax - totalCost;
            const numPerHour = 3600 / recipe.craftTimeSeconds;
            const profitPerHour = Math.round(totalProfit * numPerHour);

            // Append an element showing profit per craft
            const profitSpan = document.createElement('span');
            profitSpan.className = profitPerHour >= 0
                ? 'rounded-md px-2 py-1 text-xs font-semibold bg-gray-400/10 text-green-400 ring-green-400/20'
                : 'rounded-md px-2 py-1 text-xs font-semibold bg-red-400/10 text-red-400 ring-red-400/20';
            // You can set the text content or any other properties of the span here
            // For example, if you have a profit value, you can set it like this:
            // profitSpan.textContent = `Profit: ${calculatedProfit}`;
            profitSpan.textContent = `Profit/Hr: ${profitPerHour.toLocaleString()}`;
            button.appendChild(profitSpan);

            // Add the current recipe's data to the recipes array
            recipesData.push(recipe);
        }

        if (recipesData.length === 0) {
            console.error('Failed to find any recipes on alch page. This should not happen.');
            return;
        }

        console.debug(recipesData);
    }


    /**
     * Finds a vendor item by its name.
     *
     * @param {string} name - The name of the vendor item to find.
     * @returns {Object|null} - Returns an object representing the vendor item if found,
     * or null if no item with the given name exists. The object format is as follows:
     * {
     *   "id": number,
     *   "name": string,
     *   "image_url": string,
     *   "description": string,
     *   "type": string,
     *   "currency": string,
     *   "price": number,
     *   "sale_price": number|null,
     *   "final_price": number,
     *   "expires_in": string|null
     * }
     */
    function findVendorItemByName(name) {
        return VENDOR_ITEMS.find(item => item.name === name) || null;
    }


    /**
     * Data taken from static game files.
     */
    const VENDOR_ITEMS = [
           {
              "id":152,
              "name":"Toxilord",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/01JAG4445JFXGNNK6RSE1X73R0.png",
              "description":"",
              "type":"character_skin",
              "currency":"token",
              "price":500,
              "sale_price":null,
              "final_price":500,
              "expires_in":"1w"
           },
           {
              "id":84,
              "name":"Gleamara",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/01HP223XJ38B6V2S6EG6T6WKQZ.png",
              "description":"Deep in the old-growth forests of Oakenra, you'll find Gleamara, a force to be reckoned with on the elder council. She's not exactly winning any popularity contests, but her sharp mind and iron will command respect. Gleamara\u2019s the type who believes in getting things done, even if it ruffles a few feathers along the way. Her \"ends justify the means\" attitude might raise some eyebrows, but you can't deny she gets results. ",
              "type":"character_skin",
              "currency":"token",
              "price":400,
              "sale_price":null,
              "final_price":400,
              "expires_in":"1w"
           },
           {
              "id":82,
              "name":"Nightreaper",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/01HXVFPD6BHAKSDRS7ZRZE9KFS.png",
              "description":"Nightreaper is a dark fallen angel that lurks in the underworld. His black tattered wings cast ominous shadows. His glowing blue eyes pierce through the gloom and his menacing aura chills the air. Clad in armour, Nightreaper embodies the tragedy of a lost divinity and his presence commands fear and respect.",
              "type":"character_skin",
              "currency":"token",
              "price":500,
              "sale_price":null,
              "final_price":500,
              "expires_in":"1w"
           },
           {
              "id":72,
              "name":"Oilegeist",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/cfMtuBWne33ihfowenRtDPoa3oyTMn-metaZWFydGggMy5wbmc=-.png",
              "description":"Oilegeist, the newest face on the Oakenra council, is stirring up trouble with grand ambitions of world domination. Fresh to the political scene, they're already butting heads with Oakrum, their conflicting visions creating sparks in every council meeting. Oilegeist isn't just proud of the Oakenra - they're convinced their civilization is destined to rule over all others. With unwavering belief in Oakenra superiority, Oilegeist is set on a path that could either elevate their people or lead them into dangerous waters.",
              "type":"character_skin",
              "currency":"token",
              "price":410,
              "sale_price":null,
              "final_price":410,
              "expires_in":"1w"
           },
           {
              "id":147,
              "name":"Emberjack",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/01JAG42XBF80FV7ZMNS0G1WV4W.png",
              "description":"",
              "type":"character_skin",
              "currency":"token",
              "price":500,
              "sale_price":null,
              "final_price":500,
              "expires_in":"1w"
           },
           {
              "id":148,
              "name":"El Zombrero",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/01JAG42AH7VTKE5TB24WY91DVF.png",
              "description":"",
              "type":"character_skin",
              "currency":"token",
              "price":500,
              "sale_price":null,
              "final_price":500,
              "expires_in":"1w"
           },
           {
              "id":150,
              "name":"La Marioneta",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/01JAG43ETJYTG5JCDEEYYYKZHR.png",
              "description":"",
              "type":"character_skin",
              "currency":"token",
              "price":500,
              "sale_price":null,
              "final_price":500,
              "expires_in":"1w"
           },
           {
              "id":151,
              "name":"Voidmaw",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/01JAG44D9PXDM8RKHWX3FM65JX.png",
              "description":"",
              "type":"character_skin",
              "currency":"token",
              "price":500,
              "sale_price":null,
              "final_price":500,
              "expires_in":"1w"
           },
           {
              "id":7,
              "name":"Freya",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/01HYZXFCAJHGAK1ZN715ZMWRC4.png",
              "description":"Freya, a sneaky blonde baby-faced assassin with a swift demeanor and an obsession for cats. Her movements are quick and graceful, mirroring the felines she adores. Her light-footedness and agility make her a cunning presence.",
              "type":"character_skin",
              "currency":"token",
              "price":375,
              "sale_price":null,
              "final_price":375,
              "expires_in":null
           },
           {
              "id":57,
              "name":"Whispers of the Waves",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/lbl2Nn9vYtlRCFzrzqGqpRxFnP0upQ-metaNi5wbmc=-.png",
              "description":"A pristine coastline, where the turquoise waves kiss golden sands. The perfect harmony of land and sea, a timeless paradise.",
              "type":"background_skin",
              "currency":"token",
              "price":150,
              "sale_price":null,
              "final_price":150,
              "expires_in":null
           },
           {
              "id":58,
              "name":"Natural Disaster",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/sZtiOi7YgNv8DhtCjUVwP6eEv28vSF-metaOC5wbmc=-.png",
              "description":"The forest ablaze, flames consuming the emerald kingdom. A stark reminder of nature's fierce and untameable spirit.",
              "type":"background_skin",
              "currency":"token",
              "price":250,
              "sale_price":null,
              "final_price":250,
              "expires_in":null
           },
           {
              "id":59,
              "name":"Serenity",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/xNSSZyIwYmwQLx1MHE2TlyEgkJslZZ-metaOS5wbmc=-.png",
              "description":"A tranquil lake, embraced by majestic mountains. A mirror to the heavens, reflecting the beauty of the world above.",
              "type":"background_skin",
              "currency":"token",
              "price":200,
              "sale_price":null,
              "final_price":200,
              "expires_in":null
           },
           {
              "id":74,
              "name":"Ankhotep",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/XmkeCEyiYHv01R4LNmtKLtiQo3tlGY-metaZWd5cHRpYW4ucG5n-.png",
              "description":"Ankhotep, a name steeped in wisdom and intellect, was once an esteemed advisor to an emperor. However, his unwavering commitment to family led him to choose a humble life in the desert. A paragon of familial devotion, he embodies both the brilliance of the mind and the warmth of the heart.\n\n\n\n\n\n",
              "type":"character_skin",
              "currency":"token",
              "price":175,
              "sale_price":null,
              "final_price":175,
              "expires_in":null
           },
           {
              "id":56,
              "name":"Veils of the Valley",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/kfo5kuMkgOPacAgS5aOeEWR1gl8UgU-metaNC5wbmc=-.png",
              "description":"A rugged valley, ensconced by towering peaks. Nature's fortress, where the mountains stand sentinel over the lush, secluded haven below.",
              "type":"background_skin",
              "currency":"token",
              "price":200,
              "sale_price":null,
              "final_price":200,
              "expires_in":null
           },
           {
              "id":96,
              "name":"Winged Amethyst",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/01HQQK5DGBY4AHXNT8S46NZ2V1.png",
              "description":"",
              "type":"guild_icon",
              "currency":"token",
              "price":150,
              "sale_price":null,
              "final_price":150,
              "expires_in":null
           },
           {
              "id":97,
              "name":"Verdant Knight",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/01HQQK5452EQ13YASQDA59V4VG.png",
              "description":"",
              "type":"guild_icon",
              "currency":"token",
              "price":150,
              "sale_price":null,
              "final_price":150,
              "expires_in":null
           },
           {
              "id":98,
              "name":"Thicket Skull",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/01HQQK4W4DV4S9YCNDNJVP4SAC.png",
              "description":"",
              "type":"guild_icon",
              "currency":"token",
              "price":150,
              "sale_price":null,
              "final_price":150,
              "expires_in":null
           },
           {
              "id":99,
              "name":"Stonehelm",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/01HQQK4KJEJCR6H8DX9B8XZGFR.png",
              "description":"",
              "type":"guild_icon",
              "currency":"token",
              "price":180,
              "sale_price":null,
              "final_price":180,
              "expires_in":null
           },
           {
              "id":100,
              "name":"Spikeguard Red",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/01HQQK4C498AAXFAR3NB3DA12E.png",
              "description":"",
              "type":"guild_icon",
              "currency":"token",
              "price":150,
              "sale_price":null,
              "final_price":150,
              "expires_in":null
           },
           {
              "id":102,
              "name":"Scholars Doom",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/01HQQK3P8VBF5WH6Z7WKVKX2KF.png",
              "description":"",
              "type":"guild_icon",
              "currency":"token",
              "price":150,
              "sale_price":null,
              "final_price":150,
              "expires_in":null
           },
           {
              "id":103,
              "name":"Regal Timber",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/01HQQK3B42HY0PKJKKW878JDZZ.png",
              "description":"",
              "type":"guild_icon",
              "currency":"token",
              "price":150,
              "sale_price":null,
              "final_price":150,
              "expires_in":null
           },
           {
              "id":104,
              "name":"Prideguard",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/01HQQK2Y0R6CRKKWBC98JJHZSS.png",
              "description":"",
              "type":"guild_icon",
              "currency":"token",
              "price":150,
              "sale_price":null,
              "final_price":150,
              "expires_in":null
           },
           {
              "id":106,
              "name":"Lion Monolith",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/01HQQK2BGSDM0CN3C7BX1P61EV.png",
              "description":"",
              "type":"guild_icon",
              "currency":"token",
              "price":150,
              "sale_price":null,
              "final_price":150,
              "expires_in":null
           },
           {
              "id":108,
              "name":"Harpoon Anchor",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/01HQQK1S7PVSQKNDZPY5E9574R.png",
              "description":"",
              "type":"guild_icon",
              "currency":"token",
              "price":150,
              "sale_price":null,
              "final_price":150,
              "expires_in":null
           },
           {
              "id":109,
              "name":"Green Bone",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/01HQQK1E8J17Q9XEFTQ3AESK7Z.png",
              "description":"",
              "type":"guild_icon",
              "currency":"token",
              "price":120,
              "sale_price":null,
              "final_price":120,
              "expires_in":null
           },
           {
              "id":110,
              "name":"Granite Visage Badge",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/01HQQK15QV6WQCDERQ80S07DZY.png",
              "description":"",
              "type":"guild_icon",
              "currency":"token",
              "price":150,
              "sale_price":null,
              "final_price":150,
              "expires_in":null
           },
           {
              "id":111,
              "name":"Forest Skull",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/01HQQK07B9XMN51V5RBKX23K74.png",
              "description":"",
              "type":"guild_icon",
              "currency":"token",
              "price":150,
              "sale_price":null,
              "final_price":150,
              "expires_in":null
           },
           {
              "id":112,
              "name":"Dragonfire Aegis",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/01HQQK00JCZV7J2947MN1M2YM9.png",
              "description":"",
              "type":"guild_icon",
              "currency":"token",
              "price":150,
              "sale_price":null,
              "final_price":150,
              "expires_in":null
           },
           {
              "id":115,
              "name":"Defenders Sigil",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/01HQQJY63PA1F7MNBAHQPE3C37.png",
              "description":"",
              "type":"guild_icon",
              "currency":"token",
              "price":150,
              "sale_price":null,
              "final_price":150,
              "expires_in":null
           },
           {
              "id":117,
              "name":"Demon Skull",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/01HQQJYNQJC9TGDRFCFR7T5HYW.png",
              "description":"",
              "type":"guild_icon",
              "currency":"token",
              "price":150,
              "sale_price":null,
              "final_price":150,
              "expires_in":null
           },
           {
              "id":118,
              "name":"Crimson Guard",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/01HQQJXG83DPY5TR2QDGKR8YFN.png",
              "description":"",
              "type":"guild_icon",
              "currency":"token",
              "price":130,
              "sale_price":null,
              "final_price":130,
              "expires_in":null
           },
           {
              "id":119,
              "name":"Cobalt Bastion",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/01HQQJX5ZRT45AZ8R1VY5JH5SN.png",
              "description":"",
              "type":"guild_icon",
              "currency":"token",
              "price":130,
              "sale_price":null,
              "final_price":130,
              "expires_in":null
           },
           {
              "id":120,
              "name":"Azure Sigil",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/01HQQJWVPT7X8D7MMWMRRNRSTH.png",
              "description":"",
              "type":"guild_icon",
              "currency":"token",
              "price":130,
              "sale_price":null,
              "final_price":130,
              "expires_in":null
           },
           {
              "id":121,
              "name":"Azure Orb",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/01HQQJWHWABR02S7SKBMFH45R0.png",
              "description":"",
              "type":"guild_icon",
              "currency":"token",
              "price":130,
              "sale_price":null,
              "final_price":130,
              "expires_in":null
           },
           {
              "id":122,
              "name":"Azure Blade",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/01HQQJWANY8M303VVRQBA25E8E.png",
              "description":"",
              "type":"guild_icon",
              "currency":"token",
              "price":150,
              "sale_price":null,
              "final_price":150,
              "expires_in":null
           },
           {
              "id":127,
              "name":"Ella",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/01HT2CJ0EQ4YMSQZCD6ESRJN16.png",
              "description":"",
              "type":"character_skin",
              "currency":"token",
              "price":230,
              "sale_price":null,
              "final_price":230,
              "expires_in":null
           },
           {
              "id":146,
              "name":"Aure",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/01JAG41RS4RMGM995SYRA1P2WR.png",
              "description":null,
              "type":"character_skin",
              "currency":"token",
              "price":500,
              "sale_price":null,
              "final_price":500,
              "expires_in":null
           },
           {
              "id":18,
              "name":"Orcenzum",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/59oQguAw9Hc1GwJdrBkmezIEYneCKk-metaT3JjZW56dW0gKHJlcGxhY2UgdGhlIG9sZCBvbmUpLnBuZw==-.png",
              "description":"Orcenzum, an orc warrior, embodies the raw essence of evil yet remains a simple and loyal follower. As a commander of a small group, he grapples with the nuances of leadership, often finding himself at odds with the complexities of command. His straightforward nature contrasts with the responsibilities of his role.\n\n\n\n\n\n\n",
              "type":"character_skin",
              "currency":"token",
              "price":420,
              "sale_price":null,
              "final_price":420,
              "expires_in":null
           },
           {
              "id":42,
              "name":"Thorgarr",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/ecYIFRH5uwQMOj7yXhchIfRJSEtndQ-metadGhvcmdhcnIucG5n-.png",
              "description":"Thorgarr, a typical grunt in the ranks of malevolence, exudes an aura of brute force. His name is synonymous with brutality, and his actions are driven solely by obedience to a sinister cause. With a hulking physique and a lack of individuality, he serves as a faceless enforcer of darkness.",
              "type":"character_skin",
              "currency":"token",
              "price":425,
              "sale_price":null,
              "final_price":425,
              "expires_in":null
           },
           {
              "id":41,
              "name":"Fendral",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/ZApiuHan6dbS7UKVKlznKWHD3mNRMK-metaZmVuZHJhbC5wbmc=-.png",
              "description":"Fendral, a young and ambitious man, has a bright spark in his eyes, showing his eagerness to make a difference. Quick-thinking and always ready to learn, he approaches challenges with a mix of youthful energy and a strong sense of right and wrong, driven to improve the world around him.",
              "type":"character_skin",
              "currency":"token",
              "price":225,
              "sale_price":null,
              "final_price":225,
              "expires_in":null
           },
           {
              "id":40,
              "name":"Celestria",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/ZFIbaxVCwGZQpimXrC31ys6KdZwRzl-metaQ2VsZXN0cmlhLnBuZw==-.png",
              "description":"Celestria, cloaked in starlight, wields ancient magic with a grace that transcends time. Her eyes, pools of mystic wisdom, illuminate paths in darkness. A guardian of peace, her presence soothes troubled souls, and her touch heals the deepest of wounds. Celestria embodies the pure essence of benevolence.",
              "type":"character_skin",
              "currency":"token",
              "price":310,
              "sale_price":null,
              "final_price":310,
              "expires_in":null
           },
           {
              "id":55,
              "name":"Peaceful Night",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/KKMmT6cHVHtBJRQEmhCjevv4TT0PwH-metaNS5wbmc=-.png",
              "description":"A moonlit night of tranquility, where stars adorn the velvety canvas of the sky. Nature rests, cradled in the embrace of the nocturnal stillness.",
              "type":"background_skin",
              "currency":"token",
              "price":150,
              "sale_price":null,
              "final_price":150,
              "expires_in":null
           },
           {
              "id":28,
              "name":"Additional Bank Slot",
              "image_url":"https:\/\/cdn.idle-mmo.com\/global\/bank-slots.png",
              "description":"Increase your bank slots by 1. You can purchase a maximum of 56 additional bank slots.",
              "type":"slot",
              "currency":"token",
              "price":80,
              "sale_price":null,
              "final_price":80,
              "expires_in":null
           },
           {
              "id":27,
              "name":"Additional Pet Slot",
              "image_url":"https:\/\/cdn.idle-mmo.com\/global\/pet-slots.png",
              "description":"Increase your pet slots by 1. You can purchase a maximum of 56 additional pet slots.",
              "type":"slot",
              "currency":"token",
              "price":125,
              "sale_price":null,
              "final_price":125,
              "expires_in":null
           },
           {
              "id":26,
              "name":"Additional Inventory Slot",
              "image_url":"https:\/\/cdn.idle-mmo.com\/global\/inventory-slots.png",
              "description":"Increase your inventory slots by 1. You can purchase a maximum of 7 additional inventory slots.",
              "type":"slot",
              "currency":"token",
              "price":125,
              "sale_price":null,
              "final_price":125,
              "expires_in":null
           },
           {
              "id":25,
              "name":"Character Slot",
              "image_url":"https:\/\/cdn.idle-mmo.com\/global\/character_slot.png",
              "description":"Increase your character slots by 1.",
              "type":"slot",
              "currency":"token",
              "price":500,
              "sale_price":null,
              "final_price":500,
              "expires_in":null
           },
           {
              "id":20,
              "name":"Shiera",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/nZcbuggMyooaD5Q7RAQ01uSrkEqjp3-metaU2hpZXJhIChyZXBsYWNlIHRoZSBvbGQgb25lKS5wbmc=-.png",
              "description":"Sheira, the dark haired prince, harbors a grand ambition to conquer the world. Driven by a deep-seated desire to impress his father, the king of the underworld, his path is marked by ruthless decisions and the tragic cost of many innocent lives.",
              "type":"character_skin",
              "currency":"token",
              "price":325,
              "sale_price":null,
              "final_price":325,
              "expires_in":null
           },
           {
              "id":19,
              "name":"Roclus",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/UVCyDOy6OLahGlxUtwjz9oMiV1NatZ-metaUm9jbHVzIChyZXBsYWNlIG9sZCBvbmUpLnBuZw==-.png",
              "description":"Roclus, a simple farmer with an air of wisdom, leads a plain and unremarkable life. His neutral stance in a world of contrasting forces is pragmatic; he interacts with both good and evil creatures, motivated by the gold they bring.",
              "type":"character_skin",
              "currency":"token",
              "price":150,
              "sale_price":null,
              "final_price":150,
              "expires_in":null
           },
           {
              "id":39,
              "name":"Bronn",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/E49DbpZa7OiATj0IUfcDRSjmZBGgx4-metaYnJvbm4ucG5n-.png",
              "description":"Bronn, a traveler known for his extreme versatility and skill in sailing, was once a trader of exotic goods. His journey took a decisive turn when he embarked on a quest to defeat the witch Isodora. ",
              "type":"character_skin",
              "currency":"token",
              "price":270,
              "sale_price":null,
              "final_price":270,
              "expires_in":null
           },
           {
              "id":17,
              "name":"Mircus",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/WtOjYwsAE7HybmqgujTpR03i9uLLNp-metaTWlyY3VzIChyZXBsYWNlIHRoZSBvbGQgb25lKS5wbmc=-.png",
              "description":"Mircus, a templar knight and valiant warrior, stands as a bastion of unwavering devotion to the church and the worship of Odith. His life is dedicated to protecting the innocent, embodying the virtues of courage and righteousness. His presence is a symbol of hope and steadfast faith.",
              "type":"character_skin",
              "currency":"token",
              "price":370,
              "sale_price":null,
              "final_price":370,
              "expires_in":null
           },
           {
              "id":16,
              "name":"Melriel",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/o4CpNVC374cOzkELPgw0t4SpjdSECO-metaTWVscmllbCAocmVwbGFjZSB0aGUgb2xkIG9uZSkucG5n-.png",
              "description":"Melriel, with her luminous blonde hair and captivating blue eyes, presents an enigmatic blend of stunning beauty and intricate character. Stubborn and often cold, her actions teeter on the edge of moral ambiguity. Despite her allure, Melriel's untrustworthy nature weaves a complex web around her true intentions.",
              "type":"character_skin",
              "currency":"token",
              "price":325,
              "sale_price":null,
              "final_price":325,
              "expires_in":null
           },
           {
              "id":15,
              "name":"Leilatha",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/HPpqVLZ8jjgtiOGowfAWc2dB3IgoUR-metaTGVpbGF0aGEgKHJlcGxhY2UgdGhlIG9sZCBvbmUpLnBuZw==-.png",
              "description":"Leilatha, with her striking silver hair, exudes energy and humor. Her ever-positive attitude enables her to overcome adversity with grace. Known for her exceptional friendliness and welcoming nature, she radiates warmth and resilience, making her a cherished presence in any circle.",
              "type":"character_skin",
              "currency":"token",
              "price":325,
              "sale_price":null,
              "final_price":325,
              "expires_in":null
           },
           {
              "id":14,
              "name":"Katiyara",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/01HY0S4SPENGD285GQ5SVQA32C.png",
              "description":"Katiyara, a woman of ethereal beauty, possesses blonde hair and captivating blue eyes. Celebrated as the world's most powerful healer, her kindness resonates deeply in her every action. As a direct descendant of a god, she embodies both celestial allure and unparalleled healing gifts, embodying grace and compassion.",
              "type":"character_skin",
              "currency":"token",
              "price":350,
              "sale_price":null,
              "final_price":350,
              "expires_in":null
           },
           {
              "id":13,
              "name":"Gerrin",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/EVQcyT1TOGMeOJgQxJIPiZ8SwQAwfv-metaR2VycmluLnBuZw==-.png",
              "description":"Gerrin, a warrior of the night, grapples with his innate goodness and the evil he's come to embody. As Feron's brother, his naivety led him astray, born into circumstances that darkened his path. Yet, beneath his hardened exterior lies a heart yearning for redemption, hinting at a future where he might right his wrongs.",
              "type":"character_skin",
              "currency":"token",
              "price":415,
              "sale_price":null,
              "final_price":415,
              "expires_in":null
           },
           {
              "id":12,
              "name":"Feron",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/AKFD1fVHvACUrjqj56XwqmIxxUqXqf-metaRmVyb24gKHJlcGxhY2UgdGhlIG9sZCBvbmUpLnBuZw==-.png",
              "description":"A male embodiment of darkness, marked by evil and a haunting past of making a deal with the devil. This untrustworthy warrior of the night roams with a lost soul, a shadow amongst shadows. His resolve is chilling, stopping at nothing to achieve his sinister goals, a testament to his ominous pact.",
              "type":"character_skin",
              "currency":"token",
              "price":360,
              "sale_price":null,
              "final_price":360,
              "expires_in":null
           },
           {
              "id":11,
              "name":"Elfirma",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/oKKyU1ukyeIKN4pQ06YKHqQjJUTx4k-metaRWxmaXJtYSAocmVwbGFjZSB0aGUgb2xkIG9uZSkucG5n-.png",
              "description":"Elfirma, a strong warrior with blonde hair, is a paragon of strength and valor. Adorned in heavy armor, she stands unyielding in the face of adversity. Her warrior spirit is as formidable as her armor, symbolizing her unbreakable resolve and exemplary courage.",
              "type":"character_skin",
              "currency":"token",
              "price":360,
              "sale_price":null,
              "final_price":360,
              "expires_in":null
           },
           {
              "id":8,
              "name":"Lucian",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/GiqemTOLcJXbW7zRSFyDydbtrQWp86-metaVmVsb3IgKHJlcGxhY2UgdGhlIG9sZCBvbmUpLnBuZw==-.png",
              "description":"Lucian, a man shrouded in mystery, is always masked, embracing the shadows as his ally. His sneaky and cunning nature is honed by his devotion to the shadowblades' secretive arts. Lucian's presence is barely felt, yet his influence is profound, a silent guardian of the night.",
              "type":"character_skin",
              "currency":"token",
              "price":410,
              "sale_price":null,
              "final_price":410,
              "expires_in":null
           },
           {
              "id":1,
              "name":"Isolde",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/wpLOXlwbLIc0TjaZk4eLAqS6MoSRh5-metaY291bnR5IGdpcmwgKHJlcGxhY2UgdGhlIG9sZCBvbmUpLnBuZw==-.png",
              "description":"Isolde exudes shyness. Her eyes, often downcast, hide untold stories. The red fabric of her dress flows gracefully, symbolizing a quiet strength. Isolde's unobtrusive presence belies a deep, thoughtful personality, inviting curiosity and intrigue.",
              "type":"character_skin",
              "currency":"token",
              "price":325,
              "sale_price":null,
              "final_price":325,
              "expires_in":null
           },
           {
              "id":45,
              "name":"Alpine",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/STHyTT3MCBybquPmVj6x19PVRudw8z-metabW91bnRhaW5zLTEuanBn-.jpg",
              "description":"A riot of warm hues, where the world dons a tapestry of reds and golds. Leaves fall like confetti, whispering the arrival of autumn's embrace.",
              "type":"background_skin",
              "currency":"token",
              "price":100,
              "sale_price":null,
              "final_price":100,
              "expires_in":null
           },
           {
              "id":54,
              "name":"Golden Silence",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/te6SzhXRNb8rJDyRoMmLepZZ1gWr6D-metaMy5wbmc=-.png",
              "description":"A desolate expanse, where endless sands stretch to the horizon. Silence reigns, broken only by the whispering wind and the secrets of the dunes.",
              "type":"background_skin",
              "currency":"token",
              "price":150,
              "sale_price":null,
              "final_price":150,
              "expires_in":null
           },
           {
              "id":52,
              "name":"Moonlit Brilliance",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/NMiEeMQ4KWm0R8cUOVfUIJ9rb1GRWK-metaMS5wbmc=-.png",
              "description":"A colossal moon looms, casting an eerie glow on the world below. Its enormity dwarfs the landscape, evoking a sense of cosmic insignificance.",
              "type":"background_skin",
              "currency":"token",
              "price":200,
              "sale_price":null,
              "final_price":200,
              "expires_in":null
           },
           {
              "id":51,
              "name":"Magma's Elegy",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/O4jZzzcWEHDL00je9WgysYWhrc0ySr-metadm9sY2Fuby0xLmpwZw==-.jpg",
              "description":"Nature's fury unleashed, as molten lava spews from the earth. A cataclysmic display of raw power, where the world trembles in the face of the raging inferno.",
              "type":"background_skin",
              "currency":"token",
              "price":250,
              "sale_price":null,
              "final_price":250,
              "expires_in":null
           },
           {
              "id":50,
              "name":"Golden Farewell",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/5p1aFSRbwd5k1xOvqpa2ksIQOxH2i0-metac3Vuc2V0LTEuanBn-.jpg",
              "description":"The sun dips low, painting the horizon with fiery reds. Its reflection dances on tranquil waters, as day gracefully surrenders to night.",
              "type":"background_skin",
              "currency":"token",
              "price":100,
              "sale_price":null,
              "final_price":100,
              "expires_in":null
           },
           {
              "id":49,
              "name":"Celestial Horizon",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/LGaWmxfPOyThkGfWJrQXvphfToFubL-metac3BhY2UtMS5qcGc=-.jpg",
              "description":"Beyond, a realm veiled in mystery beckons. Alien landscapes and surreal wonders await, hinting at the boundless possibilities of the cosmos.",
              "type":"background_skin",
              "currency":"token",
              "price":100,
              "sale_price":null,
              "final_price":100,
              "expires_in":null
           },
           {
              "id":48,
              "name":"Veiled Voyage",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/FQA0KxPLa9IIBHfLFYuTkGDNHTloco-metacG9ydGFsLTEuanBn-.jpg",
              "description":"A swirling vortex of ethereal purple beckons, concealing untold realms. Its enigmatic allure invites brave souls to cross the threshold into the unknown.",
              "type":"background_skin",
              "currency":"token",
              "price":100,
              "sale_price":null,
              "final_price":100,
              "expires_in":null
           },
           {
              "id":44,
              "name":"Frozen Mirror",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/Jpjc10pYSYi3GU2bTtnLcg6sOPfjkB-metabGFrZS0xLmpwZw==-.jpg",
              "description":"A serene expanse of ice and snow, where nature sleeps beneath a crystalline blanket. Stark, tranquil, and unyielding in its frozen beauty.",
              "type":"background_skin",
              "currency":"token",
              "price":100,
              "sale_price":null,
              "final_price":100,
              "expires_in":null
           },
           {
              "id":46,
              "name":"Luminous Nocture",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/W4HzEU4FAFsEK6yePyvyY9wAdffxrr-metabmlnaHQtMS5qcGc=-.jpg",
              "description":"In the velvety night, the moon's pale glow casts a silvery spell. Shadows dance, and secrets awaken under its watchful eye.",
              "type":"background_skin",
              "currency":"token",
              "price":100,
              "sale_price":null,
              "final_price":100,
              "expires_in":null
           },
           {
              "id":47,
              "name":"Seafarer's Respite",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/TXPYmw3q1kieWstDNAovRaknbxzN4M-metacGlyYXRlLTEuanBn-.jpg",
              "description":"On the creaking deck of a pirate ship, tension simmers. An enemy vessel emerges from the mist, foreshadowing a clash on the unforgiving seas.",
              "type":"background_skin",
              "currency":"token",
              "price":100,
              "sale_price":null,
              "final_price":100,
              "expires_in":null
           },
           {
              "id":32,
              "name":"Cheap Bait",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/3SIaLLz6ogS0VLjBjFrFumeePMSZ7r-metac21hbGwgMy5wbmc=-.png",
              "description":"Used to catch fish.",
              "type":"item",
              "currency":"gold",
              "price":2,
              "sale_price":null,
              "final_price":2,
              "expires_in":null
           },
           {
              "id":33,
              "name":"Tarnished Bait",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/yE2swtjmZsVz5zhz2AyJW2iopbjBW1-metac21hbGwgMi5wbmc=-.png",
              "description":"Used to catch fish.",
              "type":"item",
              "currency":"gold",
              "price":4,
              "sale_price":null,
              "final_price":4,
              "expires_in":null
           },
           {
              "id":34,
              "name":"Gleaming Bait",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/uPmjV4t24rqH2DmrRC7obsvDPeHpL3-metac21hbGwgNS5wbmc=-.png",
              "description":"Used to catch fish.",
              "type":"item",
              "currency":"gold",
              "price":7,
              "sale_price":null,
              "final_price":7,
              "expires_in":null
           },
           {
              "id":35,
              "name":"Elemental Bait",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/LpAVIOtTcjoxc1v6Sg7jIxkmaISWh5-metaYmlnIDUucG5n-.png",
              "description":"Used to catch fish.",
              "type":"item",
              "currency":"gold",
              "price":12,
              "sale_price":null,
              "final_price":12,
              "expires_in":null
           },
           {
              "id":36,
              "name":"Eldritch Bait",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/ulyUh7wW5UhoO0h1NxlDcwlQ3zHJtj-metaYmlnIDQucG5n-.png",
              "description":"Used to catch fish.",
              "type":"item",
              "currency":"gold",
              "price":16,
              "sale_price":null,
              "final_price":16,
              "expires_in":null
           },
           {
              "id":144,
              "name":"Metamorphite",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/01J8SQJQZED2SCXVZ69S7TDE2W.png",
              "description":"Used to change the characters class. Cannot be used on Forsaken, Cursed, or Banished classes.",
              "type":"item",
              "currency":"token",
              "price":500,
              "sale_price":null,
              "final_price":500,
              "expires_in":null
           },
           {
              "id":145,
              "name":"Namestone",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/01J8SQK75C3KN0BW4NFMCRXJD9.png",
              "description":"Used to change the characters name.",
              "type":"item",
              "currency":"token",
              "price":500,
              "sale_price":null,
              "final_price":500,
              "expires_in":null
           },
           {
              "id":37,
              "name":"Arcane Bait",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/Jun8St4PqvbnKwXmF2jhqtneR5VDRc-metaYmlnIDYucG5n-.png",
              "description":"Used to catch fish.",
              "type":"item",
              "currency":"gold",
              "price":25,
              "sale_price":null,
              "final_price":25,
              "expires_in":null
           },
           {
              "id":60,
              "name":"Simple Fishing Rod",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/d64SM9vOwmqItJQ9rQEOZpKVkoXbPs-metaMy5wbmc=-.png",
              "description":"Used to catch fish.",
              "type":"item",
              "currency":"gold",
              "price":10,
              "sale_price":null,
              "final_price":10,
              "expires_in":null
           },
           {
              "id":61,
              "name":"Simple Pickaxe",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/IETUvwVxwm8JOwf0wqJiHU5BtmfrQw-metaZzUyMjYucG5n-.png",
              "description":"Used to mine ore.",
              "type":"item",
              "currency":"gold",
              "price":10,
              "sale_price":null,
              "final_price":10,
              "expires_in":null
           },
           {
              "id":62,
              "name":"Simple Felling Axe",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/SsOngUc5HJJ2Wp5P1wJlCb8qbnV6rK-metaMS5wbmc=-.png",
              "description":"Used to cut down trees.",
              "type":"item",
              "currency":"gold",
              "price":10,
              "sale_price":null,
              "final_price":10,
              "expires_in":null
           },
           {
              "id":63,
              "name":"Cheap Vial",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/yZLscrTT3OI17KN5Q0kt9Pj6knE8Mn-metaY2hlYXAtdmlhbC5wbmc=-.png",
              "description":"Used for Alchemy.",
              "type":"item",
              "currency":"gold",
              "price":5,
              "sale_price":null,
              "final_price":5,
              "expires_in":null
           },
           {
              "id":175,
              "name":"Cheap Crystal",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/0wBRbmgxQgIiwKghbkOAhHLuzJx41R-metaZWMzLnBuZw==-.png",
              "description":"Used for Alchemy.",
              "type":"item",
              "currency":"gold",
              "price":5,
              "sale_price":null,
              "final_price":5,
              "expires_in":null
           },
           {
              "id":64,
              "name":"Tarnished Vial",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/wLI7fbjcyqQNyrmrPbP2V46sJeFYSG-metadGFybmlzaGVkLXZpYWwucG5n-.png",
              "description":"Used for Alchemy.",
              "type":"item",
              "currency":"gold",
              "price":10,
              "sale_price":null,
              "final_price":10,
              "expires_in":null
           },
           {
              "id":176,
              "name":"Tarnished Crystal",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/0wBRbmgxQgIiwKghbkOAhHLuzJx41R-metaZWMzLnBuZw==-.png",
              "description":"Used for Alchemy.",
              "type":"item",
              "currency":"gold",
              "price":10,
              "sale_price":null,
              "final_price":10,
              "expires_in":null
           },
           {
              "id":65,
              "name":"Gleaming Vial",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/KzZPBlurRQXfQG5muoMtG9nQuSGljz-metaZ2xlYW1pbmctdmlhbC5wbmc=-.png",
              "description":"Used for Alchemy.",
              "type":"item",
              "currency":"gold",
              "price":50,
              "sale_price":null,
              "final_price":50,
              "expires_in":null
           },
           {
              "id":177,
              "name":"Gleaming Crystal",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/0wBRbmgxQgIiwKghbkOAhHLuzJx41R-metaZWMzLnBuZw==-.png",
              "description":"Used for Alchemy.",
              "type":"item",
              "currency":"gold",
              "price":50,
              "sale_price":null,
              "final_price":50,
              "expires_in":null
           },
           {
              "id":66,
              "name":"Elemental Vial",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/B0f623t4jTlxDWK7MprHGAXKqMUZrQ-metaZWxlbWVudGFsLXZpYWwucG5n-.png",
              "description":"Used for Alchemy.",
              "type":"item",
              "currency":"gold",
              "price":200,
              "sale_price":null,
              "final_price":200,
              "expires_in":null
           },
           {
              "id":178,
              "name":"Elemental Crystal",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/0wBRbmgxQgIiwKghbkOAhHLuzJx41R-metaZWMzLnBuZw==-.png",
              "description":"Used for Alchemy.",
              "type":"item",
              "currency":"gold",
              "price":200,
              "sale_price":null,
              "final_price":200,
              "expires_in":null
           },
           {
              "id":67,
              "name":"Eldritch Vial",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/ioO7QBZZLIVnSmrYzmgiqfQJBNzCHG-metaZWxkcml0Y2gtdmlhbC5wbmc=-.png",
              "description":"Used for Alchemy.",
              "type":"item",
              "currency":"gold",
              "price":500,
              "sale_price":null,
              "final_price":500,
              "expires_in":null
           },
           {
              "id":179,
              "name":"Eldritch Crystal",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/0wBRbmgxQgIiwKghbkOAhHLuzJx41R-metaZWMzLnBuZw==-.png",
              "description":"Used for Alchemy.",
              "type":"item",
              "currency":"gold",
              "price":500,
              "sale_price":null,
              "final_price":500,
              "expires_in":null
           },
           {
              "id":68,
              "name":"Arcane Vial",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/vmxbRmSjCseeWwS66ixNdFwb4h9OmK-metaYXJjYW5lLXZpYWwucG5n-.png",
              "description":"Used for Alchemy.",
              "type":"item",
              "currency":"gold",
              "price":2500,
              "sale_price":null,
              "final_price":2500,
              "expires_in":null
           },
           {
              "id":180,
              "name":"Arcane Crystal",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/0wBRbmgxQgIiwKghbkOAhHLuzJx41R-metaZWMzLnBuZw==-.png",
              "description":"Used for Alchemy.",
              "type":"item",
              "currency":"gold",
              "price":2500,
              "sale_price":null,
              "final_price":2500,
              "expires_in":null
           },
           {
              "id":69,
              "name":"Empty Crystal",
              "image_url":"https:\/\/cdn.idle-mmo.com\/uploaded\/skins\/0wBRbmgxQgIiwKghbkOAhHLuzJx41R-metaZWMzLnBuZw==-.png",
              "description":"Used for Alchemy.",
              "type":"item",
              "currency":"gold",
              "price":50,
              "sale_price":null,
              "final_price":50,
              "expires_in":null
           }
        ];
})();

