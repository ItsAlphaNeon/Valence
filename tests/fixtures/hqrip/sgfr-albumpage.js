/* 
If you want to add a new release to the page, this is the section you have to worry about.
Copy this:
{ID: '', Title: '', Type: ''},

  - ID is the number of the album (make sure to include s#### for Single and c#### for Soundtracks)
  - Title is the title of the album
  - Optional is for reduceable text in a name (e.g. Halation Celebration's full name)
  - Type is for sorting. Add "Album", "Single", or "Soundtrack" by your best judgement

Place that above the most recent release. 

If the title is really long and can be truncated (like Halation Celebration), add it in an " Optional: '' " tag.

By default, the first album on this list will recieve the NEW! tag, so don't worry about it.
If you need more than one NEW! tag for some reason (a double release, for example), do this:
{ID: '', Title: '', Optional: '', Type: '', New: ""},
*/

const albumData = [
    {ID: 's0003', Title: 'Remix Relay 10 (Single)', Type: 'Single'},
    {ID: '0017-b', Title: 'HIGH-QUALITY HARDCORE REMIX PACK', Optional: '[Side B]', Type: 'Album', New: ""},
    {ID: '0017-a', Title: 'HIGH-QUALITY HARDCORE REMIX PACK', Optional: '[Side A]', Type: 'Album', New: ""},
    {ID: 'c0004', Title: 'Jet Set Radio Evolution SIIVA Original Tracks', Optional: '~ Vol. 2', Type: 'Soundtrack'}, 
    {ID: '0016', Title: 'Mahjong Bangers', Type: 'Album'},
    {ID: 's0002', Title: 'MEATBALLOVANIA (Single)', Type: 'Single'},
    {ID: '0015', Title: 'Resort & Convention Center Mario', Type: 'Album'},
    {ID: '0014', Title: 'Baka Mi-Tunes', Optional: ' ~ 10th Anniversary Tribute to Baka Mitai', Type: 'Album'},
    {ID: '0013', Title: 'Mii Plaza Palooza', Type: 'Album'},
    {ID: '0012', Title: 'incompetracks', Type: 'Album'},
    {ID: 'c0003', Title: 'Eternal Katamari Original Soundtrack', Optional: 'Vol. 1 ~ "Katamari Quality Damacy"', Type: 'Soundtrack'},
    {ID: 'c0002', Title: 'Jet Set Radio Evolution SIIVA Original Tracks', Optional: '~ Vol. 1', Type: 'Soundtrack'},
    {ID: 'c0001', Title: 'Jet Set Radio Evolution SIIVA Original Tracks', Optional: '~ Vol. 0', Type: 'Soundtrack'},
    {ID: '0011', Title: 'LazyTunes', Type: 'Album'},
    {ID: '0010', Title: 'The Steam-Powered Melody Machine', Type: 'Album'},
    {ID: 's0001', Title: 'Lonely Rolling Star Fusion Collab (Single)', Type: 'Single'},
    {ID: '0009', Title: 'INSTALLER INSANITY', Type: 'Album'},
    {ID: '0008', Title: 'B💣MBERTRACKS', Type: 'Album'},
    {ID: '0007', Title: 'RIP²',Type: 'Album'},
    {ID: '0006', Title: 'Shovelware from Beyond the Deep!', Type: 'Album'},
    {ID: '0005', Title: 'Tactical Stealth Arrangements', Type: 'Album'},
    {ID: '0004', Title: 'PSY 9th Arrangements', Type: 'Album'},
    {ID: '0003', Title: 'Musical Monkey Madness', Type: 'Album'},
    {ID: '0002', Title: 'Super Star Symphony', Type: 'Album'},
    {ID: '0001', Title: 'Halation Celebration', Optional: '~ 10th Anniversary Tribute to Snow halation', Type: 'Album'}

]

// The JS should do the rest.

// 2025-08-26: add current date as cache buster
const date = new Date();
const formattedDate = date.toISOString().split('T')[0].replace(/-/g, '');

//This is the section that processes array of data into HTML formatting and places it into the viewing area
const albumHTML = albumData.map(value => { 
    let checkNew = "";
    let optionalTitle = "";
    
    //new label
    if (value == albumData[0] || value.New !== undefined) {
        checkNew = " new";
    }

    //optional text
    if (value.Optional !== undefined) {
        optionalTitle = `<span class="rs-optional"><br>${value.Optional}</span>`;
    }

    //plugs in all the variables into the block of HTML
    //toUpperCase() is for difference between links (s0001) and the actual title (S0001) of singles
    return (
	    `<a class="rs-album ${value.Type}" href="sgfr-${value.ID}/index.html">
			<img class="rs-cover" src="sgfr-${value.ID}/bc.jpg?${formattedDate}">
			<div class="rs-id${checkNew}">SGFR-${value.ID.toUpperCase()}</div>
			<div class="rs-name">${value.Title}${optionalTitle}</div>
		</a>
        `
    )
}).join(''); //connects all of that together

//Defines the album area and pipes all of album HTML into it
const albumArea = document.querySelector(".rs-container");
albumArea.innerHTML = albumHTML;

//BUTTONS!!!!! This section makes the buttons work and it's longer logic than the album section somehow
    
//Define buttons by class
const albumButton = document.querySelector('.albums');
const singleButton = document.querySelector('.singles');
const soundtrackButton = document.querySelector('.soundtracks');

//Define albums by class
const album = document.getElementsByClassName("Album");
const single = document.getElementsByClassName("Single");
const soundtrack = document.getElementsByClassName("Soundtrack");

//Surprise tool (state saver)
let activeButton = null;

//Tells buttonLogic what to do when clicking associated button
albumButton.onclick = function() {buttonLogic('Album')};
singleButton.onclick = function() {buttonLogic('Single')};
soundtrackButton.onclick = function() {buttonLogic('Soundtrack')};

/*
Expected behavior:
- On first click all gets hidden and then the correct thing gets re-toggled, state saved
  - If other button is clicked same process happens
  - If same button is clicked activeButton matches type, everything gets displayed again, state gets nulled
*/
function buttonLogic(type) {    
    if (activeButton === type) {
        changeDisplayAll('block');
        resetButtons()
        activeButton = null;
    } else {
        changeDisplayAll('none');
        resetButtons()

        if (type == 'Album') {
            changeDisplay(album, 'block');
            albumButton.classList.add('pressed');
        } else if (type == 'Single') {
            changeDisplay(single, 'block');
            singleButton.classList.add('pressed');
        } else if (type == 'Soundtrack') {
            changeDisplay(soundtrack, 'block');
            soundtrackButton.classList.add('pressed');
        }

        activeButton = type
    }
}

function changeDisplayAll(dis) {
    changeDisplay(album, dis); 
    changeDisplay(single, dis); 
    changeDisplay(soundtrack, dis);
}

function changeDisplay(type, display) {
    for(var i = 0; i < type.length; i++) {
        type[i].style.display = display;
    }
}

function resetButtons() {
    albumButton.classList.remove('pressed');
    singleButton.classList.remove('pressed');
    soundtrackButton.classList.remove('pressed');
}
