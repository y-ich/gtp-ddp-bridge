import { Mongo } from 'meteor/mongo';
import { dbOptions } from '/imports/constants.js';

export const Rooms = new Mongo.Collection('rooms', dbOptions);
