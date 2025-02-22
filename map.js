// Set your Mapbox access token
mapboxgl.accessToken = 'pk.eyJ1IjoiaGd6bm5uIiwiYSI6ImNtN2VnMmxybDA4ZXoyb3E0Y2tscndzajQifQ.OQg8FM5_ZsX_N3QTM9Li4Q';

// Initialize the map
const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/streets-v12',
    center: [-71.09415, 42.36027],
    zoom: 12,
    minZoom: 5,
    maxZoom: 18
});

const stationFlow = d3.scaleQuantize().domain([0, 1]).range([0, 0.5, 1]);

// We'll store 1440 "buckets" (one per minute of the day) for departures and arrivals.
// This lets us quickly grab only the trips we need when filtering by time.
let departuresByMinute = Array.from({ length: 1440 }, () => []);
let arrivalsByMinute   = Array.from({ length: 1440 }, () => []);

// Global array for station info
let stations = [];

// Helper function: minutes since midnight from a Date object
function minutesSinceMidnight(date) {
    return date.getHours() * 60 + date.getMinutes();
}

// Helper function: get the x,y position of a station in the current map projection
function getCoords(station) {
    const point = new mapboxgl.LngLat(+station.lon, +station.lat);
    const { x, y } = map.project(point);
    return { cx: x, cy: y };
}

// Helper function: format the slider’s minutes to HH:MM AM/PM
function formatTime(minutes) {
    const date = new Date(0, 0, 0, 0, minutes);
    return date.toLocaleString('en-US', { timeStyle: 'short' });
}

// Given a “minute,” return all trips from tripsByMinute within ±60 minutes of that minute.
// We mod by 1440 so it wraps around midnight.
function filterByMinute(tripsByMinute, minute) {
    // If no filtering is applied, return everything
    if (minute === -1) {
        return tripsByMinute.flat();
    }

    let minMinute = (minute - 60 + 1440) % 1440;
    let maxMinute = (minute + 60) % 1440;

    // If minMinute > maxMinute, it means we cross midnight; handle in two slices
    if (minMinute > maxMinute) {
        const beforeMidnight = tripsByMinute.slice(minMinute);
        const afterMidnight  = tripsByMinute.slice(0, maxMinute);
        return beforeMidnight.concat(afterMidnight).flat();
    } else {
        return tripsByMinute.slice(minMinute, maxMinute).flat();
    }
}

// Compute station traffic, given a time filter
// This uses the bucketed trips for much faster lookups.
function computeStationTraffic(stations, timeFilter = -1) {
    // All departures that are within ±60 min of timeFilter
    const departures = d3.rollup(
        filterByMinute(departuresByMinute, timeFilter),
        (v) => v.length,
        (d) => d.start_station_id
    );
    // All arrivals that are within ±60 min of timeFilter
    const arrivals = d3.rollup(
        filterByMinute(arrivalsByMinute, timeFilter),
        (v) => v.length,
        (d) => d.end_station_id
    );

    // Return a fresh array of stations with updated arrivals/departures/total
    return stations.map(station => {
        let id = station.short_name;
        const depCount = departures.get(id) ?? 0;
        const arrCount = arrivals.get(id)   ?? 0;
        return {
        ...station,
        departures: depCount,
        arrivals: arrCount,
        totalTraffic: depCount + arrCount
        };
    });
}

map.on('load', () => {
    // Add the Boston bike lanes
    map.addSource('boston_route', {
        type: 'geojson',
        data: 'https://bostonopendata-boston.opendata.arcgis.com/datasets/boston::existing-bike-network-2022.geojson?...'
    });
    map.addLayer({
        id: 'bike-lanes',
        type: 'line',
        source: 'boston_route',
        paint: {
        'line-color': '#32D400',
        'line-width': 3,
        'line-opacity': 0.4
        }
    });

    // Add the Cambridge bike lanes
    map.addSource('cambridge_route', {
        type: 'geojson',
        data: 'https://raw.githubusercontent.com/cambridgegis/cambridgegis_data/main/Recreation/Bike_Facilities/RECREATION_BikeFacilities.geojson'
    });
    map.addLayer({
        id: 'bike-lanes-cambridge',
        type: 'line',
        source: 'cambridge_route',
        paint: {
        'line-color': '#32D400',
        'line-width': 3,
        'line-opacity': 0.4
        }
    });

    // Select the SVG overlay inside the #map container
    const svg = d3.select('#map').select('svg');

    // Load station data
    d3.json('https://dsc106.com/labs/lab07/data/bluebikes-stations.json')
        .then(jsonData => {
        stations = jsonData.data.stations;

        // Create circles (one per station), keyed by short_name
        const circles = svg
            .selectAll('circle')
            .data(stations, d => d.short_name)
            .enter()
            .append('circle')
            // .attr('fill', 'steelblue')
            .attr('stroke', 'white')
            .attr('stroke-width', 1)
            .attr('opacity', 0.6)
            .style('--departure-ratio', d => stationFlow(d.departures / d.totalTraffic));

        // After stations load, load trip data and populate our minute-buckets
        return d3.csv(
            'https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv',
            // The second argument to d3.csv() is a "row conversion" function
            trip => {
            // Convert timestamps to Date objects right away
            trip.started_at = new Date(trip.started_at);
            trip.ended_at   = new Date(trip.ended_at);
            return trip;
            }
        ).then(trips => {
            // Fill the departuresByMinute and arrivalsByMinute arrays
            trips.forEach(trip => {
            const started = minutesSinceMidnight(trip.started_at);
            const ended   = minutesSinceMidnight(trip.ended_at);
            // Put this trip in the correct departure bucket
            departuresByMinute[started].push(trip);
            // Put this trip in the correct arrival bucket
            arrivalsByMinute[ended].push(trip);
            });

            // Initially, no time filtering => timeFilter = -1
            // So let's get the station traffic for all trips
            const allTripsStations = computeStationTraffic(stations, -1);

            // Build a radius scale for the initial view
            let radiusScale = d3
            .scaleSqrt()
            .domain([0, d3.max(allTripsStations, d => d.totalTraffic)])
            .range([0, 25]);

            // Apply the initial circle radius + a <title> for tooltip
            circles
            .data(allTripsStations, d => d.short_name)
            .attr('r', d => radiusScale(d.totalTraffic))
            .each(function(d) {
                d3.select(this).select('title').remove();
                d3.select(this)
                .append('title')
                .text(`${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`);
            });

            // Reposition the circles on the map
            function updatePositions() {
            circles
                .attr('cx', d => getCoords(d).cx)
                .attr('cy', d => getCoords(d).cy);
            }
            updatePositions();
            map.on('move',   updatePositions);
            map.on('zoom',   updatePositions);
            map.on('resize', updatePositions);
            map.on('moveend',updatePositions);

            // Now wire up the slider and interactive filtering
            const timeSlider    = document.getElementById('time-slider');
            const selectedTime  = document.getElementById('selected-time');
            const anyTimeLabel  = document.getElementById('any-time');

            // The function that actually updates the scatterplot
            // whenever the time filter changes
            function updateScatterPlot(timeFilter) {
            // Recompute station traffic under the time filter
            const filteredStations = computeStationTraffic(stations, timeFilter);

            // Dynamically change the radius scale range based on filtering
            // So circles are larger if fewer trips are shown
            if (timeFilter === -1) {
                radiusScale.range([0, 25]);
            } else {
                radiusScale.range([3, 50]);
            }

            // Update each circle’s radius + tooltip
            circles
                .data(filteredStations, d => d.short_name)
                .join('circle') // Ensures correct update pattern
                .attr('r', d => radiusScale(d.totalTraffic))
                .each(function(d) {
                d3.select(this).select('title').remove();
                d3.select(this)
                    .append('title')
                    .text(`${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`);
                });

            // Also re-position them (in case map was moved while data changed)
            updatePositions();
            }

            // Update the time label + call updateScatterPlot
            function updateTimeDisplay() {
            const timeFilter = Number(timeSlider.value);

            if (timeFilter === -1) {
                selectedTime.textContent    = '';
                anyTimeLabel.style.display  = 'block';
            } else {
                selectedTime.textContent    = formatTime(timeFilter);
                anyTimeLabel.style.display  = 'none';
            }

            updateScatterPlot(timeFilter);
            }

            // Listen for slider changes
            timeSlider.addEventListener('input', updateTimeDisplay);

            // Initialize everything with no time filtering
            updateTimeDisplay();
        });
    })
    .catch(err => {
        console.error('Error loading station or trip data:', err);
    });
});
