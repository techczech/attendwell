// One attendance eligibility policy for store, participant API, exports and the organiser interface.
// Confirmed bookings are eligible; waiting-list bookings only after explicit organiser admission; cancelled never.
export type EligibilityFields={booking:string;admitted?:boolean|number};
export const isEligible=(p:EligibilityFields)=>p.booking==='confirmed'||p.booking==='waiting'&&!!p.admitted;
export const eligibleSql="(booking='confirmed' OR (booking='waiting' AND admitted=1))";
