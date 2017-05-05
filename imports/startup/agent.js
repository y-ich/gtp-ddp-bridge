import { Tracker } from 'meteor/tracker';
import { KAKO_SELECTOR, twiigo } from '/imports/constants.js';
import { PonderAgent } from '/imports/server/agent.js';

twiigo.subscribe('users', KAKO_SELECTOR, function() {
    const kako = new PonderAgent(KAKO_SELECTOR, twiigo);
    twiigo.subscribe('rooms', kako.getRoomsSelector());
    Tracker.autorun(function() {
        if (twiigo.status().connected) {
            twiigo.call('setUserId', kako.id);
            kako.observe();
        } else {
            kako.stopObserve();
        }
    });
});
