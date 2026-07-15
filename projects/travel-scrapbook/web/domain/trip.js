// domain/trip.js — trip + anchor operations against the API, store-backed.
'use strict';

const TripDomain = {
  async loadAll() {
    const res = await window.api.listTrips();
    window.store.set('trips', res.trips);
    return res.trips;
  },

  async load(tripId) {
    const trip = await window.api.getTrip(tripId);
    window.store.set('trip:' + tripId, trip);
    return trip;
  },

  async create(fields) {
    const trip = await window.api.createTrip(fields);
    await this.loadAll();
    return trip;
  },

  async update(tripId, fields) {
    await window.api.updateTrip(tripId, fields);
    return this.load(tripId);
  },

  async remove(tripId) {
    await window.api.deleteTrip(tripId);
    await this.loadAll();
  },

  async addAnchor(tripId, fields) {
    const anchor = await window.api.createAnchor(tripId, fields);
    await this.load(tripId);
    return anchor;
  },

  async removeAnchor(tripId, anchorId) {
    await window.api.deleteAnchor(anchorId);
    await this.load(tripId);
  },
};
window.TripDomain = TripDomain;
