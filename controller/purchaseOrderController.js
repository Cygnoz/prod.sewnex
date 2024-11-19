const PurchaseOrder = require('../database/model/purchaseOrder');
const Organization = require('../database/model/organization');
const Item = require('../database/model/item');
const Supplier = require('../database/model/supplier');
const Customer = require('../database/model/customer');
const Settings = require("../database/model/settings")
const Tax = require('../database/model/tax');
const Prefix = require("../database/model/prefix");
const moment = require("moment-timezone");
const mongoose = require('mongoose');



// Fetch existing data
const dataExist = async ( organizationId, supplierId, items ) => {
    const itemIds = items.map(item => item.itemId);

    const [organizationExists, supplierExist, itemTable, taxExists, settings, existingPrefix] = await Promise.all([
      Organization.findOne({ organizationId }, { organizationId: 1, organizationCountry: 1, state: 1 }),
      Supplier.findOne({ organizationId , _id:supplierId}, { _id: 1, supplierDisplayName: 1, taxType: 1 }),
      Item.find({ organizationId, _id: { $in: itemIds } }, { _id: 1, itemName: 1, taxPreference: 1, costPrice:1,  taxRate: 1, cgst: 1, sgst: 1, igst: 1, vat: 1 }),
      Tax.findOne({ organizationId }),
      Settings.findOne({ organizationId }),
      Prefix.findOne({ organizationId })
    ]);    
  return { organizationExists, supplierExist, itemTable, taxExists, settings, existingPrefix };
};



const purchaseOrderDataExist = async ( organizationId, orderId ) => {    
    const [organizationExists, allPurchaseOrder, purchaseOrder ] = await Promise.all([
      Organization.findOne({ organizationId }, { organizationId: 1}),
      PurchaseOrder.find({ organizationId }),
      PurchaseOrder.findOne({ organizationId , _id: orderId })
    ]);
    return { organizationExists, allPurchaseOrder, purchaseOrder };
  };



// Add Purchase Order
exports.addPurchaseOrder = async (req, res) => {
    // console.log("Add Purchase Order:", req.body);
  
    try {
      const { organizationId, id: userId, userName } = req.user;
  
      //Clean Data
      const cleanedData = cleanPurchaseOrderData(req.body);
  
      const { items } = cleanedData;
      const { supplierId } = cleanedData;
      
      const itemIds = items.map(item => item.itemId);      
      
      // Check for duplicate itemIds
      const uniqueItemIds = new Set(itemIds);
      if (uniqueItemIds.size !== itemIds.length) {
        return res.status(400).json({ message: "Duplicate Item found" });
      }
  
      //Validate Supplier
      if (!mongoose.Types.ObjectId.isValid(supplierId) || supplierId.length !== 24) {
        return res.status(400).json({ message: `Invalid supplier ID: ${supplierId}` });
      }
  
      // Validate ItemIds
      const invalidItemIds = itemIds.filter(itemId => !mongoose.Types.ObjectId.isValid(itemId) || itemId.length !== 24);
      if (invalidItemIds.length > 0) {
        return res.status(400).json({ message: `Invalid item IDs: ${invalidItemIds.join(', ')}` });
      }   
  
      const { organizationExists, supplierExist, itemTable, taxExists, settings, existingPrefix } = await dataExist( organizationId, supplierId, items );
    
      //Data Exist Validation
      if (!validateOrganizationSupplierPrefix( organizationExists, supplierExist, existingPrefix, res )) return;
  
      //Validate Inputs  
      if (!validateInputs( cleanedData, supplierExist, items, itemTable, organizationExists, res)) return;
  
      //Date & Time
      const openingDate = generateOpeningDate(organizationExists);
  
      //Tax Type
      taxtype(cleanedData, supplierExist );
      
      // Calculate Sales 
      if (!calculatePurchaseOrder( cleanedData, itemTable, res )) return;

      //Prefix
      await purchaseOrderPrefix(cleanedData, existingPrefix );
  
      const savedPurchaseOrder = await createNewPurchaseOrder(cleanedData, organizationId, openingDate, userId, userName );
        
      res.status(201).json({ message: "Purchase order created successfully", savedPurchaseOrder });
      // console.log( "Purchase order created successfully:", savedPurchaseOrder );
    } catch (error) {
      console.error("Error Creating Purchase Order:", error);
      res.status(500).json({ message: "Internal server error." });
    }
  }
  
  
  
  // Get All Purchase Order
  exports.getAllPurchaseOrder = async (req, res) => {
    try {
      const organizationId = req.user.organizationId;
  
      const { organizationExists, allPurchaseOrder } = await purchaseOrderDataExist(organizationId);
  
      if (!organizationExists) {
        return res.status(404).json({
          message: "Organization not found",
        });
      }
  
      if (!allPurchaseOrder.length) {
        return res.status(404).json({
          message: "No purchase order found",
        });
      }
  
      res.status(200).json(allPurchaseOrder);
    } catch (error) {
      console.error("Error fetching purchase order:", error);
      res.status(500).json({ message: "Internal server error." });
    }
  };
  
  
 // Get One Purchase Order
 exports.getOnePurchaseOrder = async (req, res) => {
    try {
      const organizationId = req.user.organizationId;
      const orderId = req.params.orderId;
    
      const { organizationExists, purchaseOrder } = await purchaseOrderDataExist(organizationId, orderId);
    
      if (!organizationExists) {
        return res.status(404).json({
          message: "Organization not found",
        });
      }
    
      if (!purchaseOrder) {
        return res.status(404).json({
          message: "No purchase order found",
        });
      }

      res.status(200).json(purchaseOrder);
    } catch (error) {
      console.error("Error fetching purchase order:", error);
      res.status(500).json({ message: "Internal server error." });
    }
    };
  
  
// Get Last Journal Prefix
exports. getLastPurchaseOrderPrefix = async (req, res) => {
    try {
        const organizationId = req.user.organizationId;
  
        // Find all accounts where organizationId matches
        const prefix = await Prefix.findOne({ organizationId:organizationId,'series.status': true });
  
        if (!prefix) {
            return res.status(404).json({
                message: "No Prefix found for the provided organization ID.",
            });
        }
        
        const series = prefix.series[0];     
        const lastPrefix = series.purchaseOrder + series.purchaseOrderNum;
  
        res.status(200).json(lastPrefix);
    } catch (error) {
        console.error("Error fetching accounts:", error);
        res.status(500).json({ message: "Internal server error." });
    }
  };
  

  // Purchase Prefix
  function purchaseOrderPrefix( cleanData, existingPrefix ) {
    const activeSeries = existingPrefix.series.find(series => series.status === true);
    if (!activeSeries) {
        return res.status(404).json({ message: "No active series found for the organization." });
    }
    cleanData.purchaseOrder = `${activeSeries.purchaseOrder}${activeSeries.purchaseOrderNum}`;
  
    activeSeries.purchaseOrderNum += 1;
  
    existingPrefix.save()
  
    return 
  }






   // Create New Purchase Order
   function createNewPurchaseOrder( data, organizationId, openingDate, userId, userName ) {
    const newPurchaseOrder = new PurchaseOrder({ ...data, organizationId, createdDate: openingDate, userId, userName });
    return newPurchaseOrder.save();
  }
  
  
  //Clean Data 
  function cleanPurchaseOrderData(data) {
    const cleanData = (value) => (value === null || value === undefined || value === "" ? undefined : value);
    return Object.keys(data).reduce((acc, key) => {
      acc[key] = cleanData(data[key]);
      return acc;
    }, {});
  }
  
  
  // Validate Organization Tax Currency
  function validateOrganizationSupplierPrefix( organizationExists, supplierExist, existingPrefix, res ) {
    if (!organizationExists) {
      res.status(404).json({ message: "Organization not found" });
      return false;
    }
    if (!supplierExist) {
      res.status(404).json({ message: "Supplier not found." });
      return false;
    }
    if (!existingPrefix) {
      res.status(404).json({ message: "Prefix not found" });
      return false;
    }
    return true;
  }
  
  
  
  // Tax Type
  function taxtype( cleanedData, supplierExist ) {
    if(supplierExist.taxType === 'GST' ){
      if(cleanedData.sourceOfSupply === cleanedData.destinationOfSupply){
        cleanedData.taxMode ='Intra';
      }
      else{
        cleanedData.taxMode ='Inter';
      }
    }
    if(supplierExist.taxType === 'VAT' ){
      cleanedData.taxMode ='VAT'; 
    }
    return   
  }



  function calculatePurchaseOrder(cleanedData, itemTable, res) {
    const errors = [];
  
    let otherExpense = (cleanedData.otherExpense || 0);
    let freightAmount = (cleanedData.freight || 0);
    let roundOffAmount = (cleanedData.roundOff || 0);
    let subTotal = 0;
    let totalTaxAmount = 0;
    let itemTotalDiscount= 0;
    let totalItem = 0;
    let transactionDiscountAmount = 0;
    let grandTotal = 0;
  
    // Utility function to round values to two decimal places
    const roundToTwoDecimals = (value) => Number(value.toFixed(2));  
  
    cleanedData.items.forEach(item => {
  
      let calculatedItemCgstAmount = 0;
      let calculatedItemSgstAmount = 0;
      let calculatedItemIgstAmount = 0;
      let calculatedItemVatAmount = 0;
      let calculatedItemTaxAmount = 0;
      let itemAmount = 0;
      let taxMode = cleanedData.taxMode;
  
      // Calculate item line discount 
      const itemDiscAmt = calculateItemDiscount(item);
  
      itemTotalDiscount +=  parseFloat(itemDiscAmt);
      totalItem +=  parseInt(item.itemQuantity);
      subTotal += parseFloat(item.itemQuantity * item.itemCostPrice);
  
      itemAmount = (item.itemCostPrice * item.itemQuantity - itemDiscAmt);
  
      // Handle tax calculation only for taxable items
      itemTable.forEach(i => {
      if (i.taxPreference === 'Taxable') {
        switch (taxMode) {
          
          case 'Intra':
            calculatedItemCgstAmount = roundToTwoDecimals((item.itemCgst / 100) * itemAmount);
            calculatedItemSgstAmount = roundToTwoDecimals((item.itemSgst / 100) * itemAmount);
          break;
  
          case 'Inter':
            calculatedItemIgstAmount = roundToTwoDecimals((item.itemIgst / 100) * itemAmount);
          break;
          
          case 'VAT':
            calculatedItemVatAmount = roundToTwoDecimals((item.itemVat / 100) * itemAmount);
          break;
  
        }
  
        calculatedItemTaxAmount =  calculatedItemCgstAmount + calculatedItemSgstAmount + calculatedItemIgstAmount + calculatedItemVatAmount;
        
        // Check tax amounts
        checkAmount(calculatedItemCgstAmount, item.itemCgstAmount, item.itemName, 'CGST',errors);
        checkAmount(calculatedItemSgstAmount, item.itemSgstAmount, item.itemName, 'SGST',errors);
        checkAmount(calculatedItemIgstAmount, item.itemIgstAmount, item.itemName, 'IGST',errors);
        checkAmount(calculatedItemVatAmount, item.itemVatAmount, item.itemName, 'VAT',errors);
        checkAmount(calculatedItemTaxAmount, item.itemTax, item.itemName, 'Item tax',errors);
  
        totalTaxAmount += calculatedItemTaxAmount;     
  
      } else {
        console.log(`Skipping Tax for Non-Taxable item: ${item.itemName}`);
        console.log(`Item: ${item.itemName}, Calculated Discount: ${itemDiscAmt}`);
      }
      })
  
      checkAmount(itemAmount, item.itemAmount, item.itemName, 'Item Total',errors);
  
      console.log(`${item.itemName} Item Total: ${itemAmount} , Provided ${item.itemAmount}`);
      console.log(`${item.itemName} Total Tax: ${calculatedItemTaxAmount} , Provided ${item.itemTax || 0 }`);
      console.log("");
    });
  
    const total = (
        (subTotal + totalTaxAmount + otherExpense + freightAmount - roundOffAmount) - itemTotalDiscount
    );
  
    console.log(`SubTotal: ${subTotal} , Provided ${cleanedData.subTotal}`);
    console.log(`Total: ${total} , Provided ${total}`);
  
    // Transaction Discount
    let transDisAmt = calculateTransactionDiscount(cleanedData, total, transactionDiscountAmount); 
  
    // grandTotal amount calculation with including transactionDiscount
    grandTotal = total - transDisAmt; 
    console.log(`Grand Total: ${grandTotal} , Provided ${cleanedData.grandTotal}`);
  
    // Round the totals for comparison
    const roundedSubTotal = roundToTwoDecimals(subTotal); 
    const roundedTotalTaxAmount = roundToTwoDecimals(totalTaxAmount);
    const roundedGrandTotalAmount = roundToTwoDecimals(grandTotal);
    const roundedTotalItemDiscount = roundToTwoDecimals(itemTotalDiscount);
  
    console.log(`Final Sub Total: ${roundedSubTotal} , Provided ${cleanedData.subTotal}` );
    console.log(`Final Total Tax Amount: ${roundedTotalTaxAmount} , Provided ${cleanedData.totalTaxAmount}` );
    console.log(`Final Total Amount: ${roundedGrandTotalAmount} , Provided ${cleanedData.grandTotal}` );
    console.log(`Final Total Item Discount Amount: ${roundedTotalItemDiscount} , Provided ${cleanedData.itemTotalDiscount}` );
  
    validateAmount(roundedSubTotal, cleanedData.subTotal, 'SubTotal', errors);
    validateAmount(roundedTotalTaxAmount, cleanedData.totalTaxAmount, 'Total Tax Amount', errors);
    validateAmount(roundedGrandTotalAmount, cleanedData.grandTotal, 'Grand Total', errors);
    validateAmount(roundedTotalItemDiscount, cleanedData.itemTotalDiscount, 'Total Item Discount Amount', errors);
    validateAmount(totalItem, cleanedData.totalItem, 'Total Item count', errors);
  
    if (errors.length > 0) {
      res.status(400).json({ message: errors.join(", ") });
      return false;
    }
  
    return true;
  }
  
  
  // Calculate item discount
  function calculateItemDiscount(item) {
    return item.itemDiscountType === 'currency'
      ? item.itemDiscount || 0
      : (item.itemCostPrice * item.itemQuantity * (item.itemDiscount || 0)) / 100;    //if percentage
  }
  
  
  //TransactionDiscount
  function calculateTransactionDiscount(cleanedData, total, transactionDiscountAmount) {
    transactionDiscountAmount = cleanedData.transactionDiscount || 0;
  
    return cleanedData.transactionDiscountType === 'currency'
      ? transactionDiscountAmount
      : (total * cleanedData.transactionDiscount) / 100;    //if percentage
  }
  
  
  //Mismatch Check
  function checkAmount(calculatedAmount, providedAmount, itemName, taxMode, errors) {
    const roundToTwoDecimals = (value) => Number(value.toFixed(2)); // Round to two decimal places
    const roundedAmount = roundToTwoDecimals(calculatedAmount);
    console.log(`Item: ${itemName}, Calculated ${taxMode}: ${roundedAmount}, Provided data: ${providedAmount}`);
  
    if (Math.abs(roundedAmount - providedAmount) > 0.01) {
      const errorMessage = `Mismatch in ${taxMode} for item ${itemName}: Calculated ${calculatedAmount}, Provided ${providedAmount}`;
      errors.push(errorMessage);
      console.log(errorMessage);
    }
  }
  
  
  //Final Item Amount check
  const validateAmount = ( calculatedValue, cleanedValue, label, errors ) => {
    const isCorrect = calculatedValue === parseFloat(cleanedValue);
    if (!isCorrect) {
      const errorMessage = `${label} is incorrect: ${cleanedValue}`;
      errors.push(errorMessage);
      console.log(errorMessage);
    }
  };



   //Return Date and Time 
function generateOpeningDate(organizationExists) {
    const date = generateTimeAndDateForDB(
        organizationExists.timeZoneExp,
        organizationExists.dateFormatExp,
        organizationExists.dateSplit
      )
    return date.dateTime;
  }
  
  
  // Function to generate time and date for storing in the database
  function generateTimeAndDateForDB(
    timeZone,
    dateFormat,
    dateSplit,
    baseTime = new Date(),
    timeFormat = "HH:mm:ss",
    timeSplit = ":"
  ) {
    // Convert the base time to the desired time zone
    const localDate = moment.tz(baseTime, timeZone);
  
    // Format date and time according to the specified formats
    let formattedDate = localDate.format(dateFormat);
  
    // Handle date split if specified
    if (dateSplit) {
      // Replace default split characters with specified split characters
      formattedDate = formattedDate.replace(/[-/]/g, dateSplit); // Adjust regex based on your date format separators
    }
  
    const formattedTime = localDate.format(timeFormat);
    const timeZoneName = localDate.format("z"); // Get time zone abbreviation
  
    // Combine the formatted date and time with the split characters and time zone
    const dateTime = `${formattedDate} ${formattedTime
      .split(":")
      .join(timeSplit)} (${timeZoneName})`;
  
    return {
      date: formattedDate,
      time: `${formattedTime} (${timeZoneName})`,
      dateTime: dateTime,
    };
  }




  //Validate inputs
function validateInputs( data, supplierExist, items, itemExists, organizationExists, res) {
    const validationErrors = validateBillsData(data, supplierExist, items, itemExists, organizationExists);  
  
    if (validationErrors.length > 0) {
      res.status(400).json({ message: validationErrors.join(", ") });
      return false;
    }
    return true;
  }
  
  //Validate Data
  function validateBillsData( data, supplierExist, items, itemTable, organizationExists ) {
    const errors = [];
  
    // console.log("Item Request :",items);
    // console.log("Item Fetched :",itemTable);
  
    //Basic Info
    validateReqFields( data, supplierExist, errors );
    validateItemTable(items, itemTable, errors);
    validateShipmentPreferences(data.shipmentPreference, errors)
    validateTransactionDiscountType(data.transactionDiscountType, errors);
    // console.log("billExist Data:", billExist.billNumber, billExist.billDate, billExist.orderNumber)
  
    //OtherDetails
    validateIntegerFields(['totalItem'], data, errors);
    validateFloatFields(['transactionDiscountAmount','subTotal','cgst','sgst','igst','vat','totalTaxAmount','grandTotal'], data, errors);
    //validateAlphabetsFields(['department', 'designation'], data, errors);
  
    //Tax Details
    //validateTaxType(data.taxType, validTaxTypes, errors);
    validateSourceOfSupply(data.sourceOfSupply, organizationExists, errors);
    validateDestinationOfSupply(data.destinationOfSupply, organizationExists, errors);
    validatePaymentTerms(data.paymentTerms, errors);
    //validateGSTorVAT(data, errors);
  
    //Currency
    //validateCurrency(data.currency, validCurrencies, errors);
  
    //Address
    //validateBillingAddress(data, errors);
    //validateShippingAddress(data, errors);  
    return errors;
  }
  
  
  
  // Field validation utility
  function validateField(condition, errorMsg, errors) {
    if (condition) errors.push(errorMsg);
  }
  
  
  //Valid Req Fields
  function validateReqFields( data, supplierExist, errors ) {
  validateField( typeof data.supplierId === 'undefined' || typeof data.supplierDisplayName === 'undefined', "Please select a Supplier", errors  );
  validateField( supplierExist.taxtype == 'GST' && typeof data.sourceOfSupply === 'undefined', "Source of supply required", errors  );
  validateField( supplierExist.taxtype == 'GST' && typeof data.destinationOfSupply === 'undefined', "Destination of supply required", errors  );
  validateField( typeof data.items === 'undefined', "Select an item", errors  );
  }
  
  
  // Function to Validate Item Table 
  function validateItemTable(items, itemTable, errors) {
  // Check for item count mismatch
  validateField( items.length !== itemTable.length, "Mismatch in item count between request and database.", errors  );
  
  // Iterate through each item to validate individual fields
  items.forEach((item) => {
    const fetchedItem = itemTable.find(it => it._id.toString() === item.itemId);
  
    // Check if item exists in the item table
    validateField( !fetchedItem, `Item with ID ${item.itemId} was not found.`, errors );
    if (!fetchedItem) return; 
  
    // Validate item name
    validateField( item.itemName !== fetchedItem.itemName, `Item Name Mismatch : ${item.itemName}`, errors );
  
    // Validate cost price
    validateField( item.itemCostPrice !== fetchedItem.costPrice, `Cost price Mismatch for ${item.itemName}:  ${item.itemCostPrice}`, errors );
  
    // Validate CGST
    validateField( item.itemCgst !== fetchedItem.cgst, `CGST Mismatch for ${item.itemName}: ${item.itemCgst}`, errors );
  
    // Validate SGST
    validateField( item.itemSgst !== fetchedItem.sgst, `SGST Mismatch for ${item.itemName}: ${item.itemSgst}`, errors );
  
    // Validate IGST
    validateField( item.itemIgst !== fetchedItem.igst, `IGST Mismatch for ${item.itemName}: ${item.itemIgst}`, errors );
  
    // Validate discount type
    validateItemDiscountType(item.itemDiscountType, errors);
  
    // Validate integer fields
    validateIntegerFields(['itemQuantity'], item, errors);
  
    // Validate Stock Count 
    validateField( item.itemQuantity > fetchedItem.currentStock, `Insufficient Stock for ${item.itemName}: Requested quantity ${item.itemQuantity}, Available stock ${fetchedItem.currentStock}`, errors );
  
    // Validate float fields
    validateFloatFields(['itemCostPrice', 'itemTotaltax', 'itemAmount'], item, errors);
  });
  }





  // Validate source Of Supply
function validateSourceOfSupply(sourceOfSupply, organization, errors) {
    validateField(
      sourceOfSupply && !validCountries[organization.organizationCountry]?.includes(sourceOfSupply),
      "Invalid Source of Supply: " + sourceOfSupply, errors );
  }
  
  // Validate destination Of Supply
  function validateDestinationOfSupply(destinationOfSupply, organization, errors) {
    validateField(
      destinationOfSupply && !validCountries[organization.organizationCountry]?.includes(destinationOfSupply),
      "Invalid Destination of Supply: " + destinationOfSupply, errors );
  }

   // Validate Payment Terms
   function validateShipmentPreferences(shipmentPreference, errors) {
    validateField(
        shipmentPreference && !validShipmentPreferences.includes(shipmentPreference),
      "Invalid Shipment Preference: " + shipmentPreference, errors );
  }
  
  //Validate Discount Transaction Type
  function validateTransactionDiscountType(transactionDiscountType, errors) {
  validateField(transactionDiscountType && !validTransactionDiscountType.includes(transactionDiscountType),
    "Invalid Transaction Discount: " + transactionDiscountType, errors);
  } 
  
  //Validate Item Discount Transaction Type
  function validateItemDiscountType(itemDiscountType, errors) {
    validateField(itemDiscountType && !validItemDiscountType.includes(itemDiscountType),
      "Invalid Item Discount: " + itemDiscountType, errors);
  }
  
  // Validate Payment Terms
  function validatePaymentTerms(paymentTerms, errors) {
    validateField(
       paymentTerms && !validPaymentTerms.includes(paymentTerms),
      "Invalid Payment Terms: " + paymentTerms, errors );
  }
  
  
  
  
  //Valid Alphanumeric Fields
  function validateAlphanumericFields(fields, data, errors) {
    fields.forEach((field) => {
      validateField(data[field] && !isAlphanumeric(data[field]), "Invalid " + field + ": " + data[field], errors);
    });
  }
  // Validate Integer Fields
  function validateIntegerFields(fields, data, errors) {
  fields.forEach(field => {
    validateField(data[field] && !isInteger(data[field]), `Invalid ${field}: ${data[field]}`, errors);
  });
  }
  //Valid Float Fields  
  function validateFloatFields(fields, data, errors) {
    fields.forEach((balance) => {
      validateField(data[balance] && !isFloat(data[balance]),
        "Invalid " + balance.replace(/([A-Z])/g, " $1") + ": " + data[balance], errors);
    });
  }
  //Valid Alphabets Fields 
  function validateAlphabetsFields(fields, data, errors) {
    fields.forEach((field) => {
      if (data[field] !== undefined) {
        validateField(!isAlphabets(data[field]),
          field.charAt(0).toUpperCase() + field.slice(1) + " should contain only alphabets.", errors);
      }
    });
  }
  
  
  
  
  // Helper functions to handle formatting
  function capitalize(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
  }
  
  function formatCamelCase(word) {
  return word.replace(/([A-Z])/g, " $1");
  }
  
  // Validation helpers
  function isAlphabets(value) {
  return /^[A-Za-z\s]+$/.test(value);
  }
  
  function isFloat(value) {
  return /^-?\d+(\.\d+)?$/.test(value);
  }
  
  function isInteger(value) {
  return /^\d+$/.test(value);
  }
  
  function isAlphanumeric(value) {
  return /^[A-Za-z0-9]+$/.test(value);
  }
  
  function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }


  

  // Utility functions
  const validShipmentPreferences = ["Road", "Rail", "Air", "Sea", "Courier", "Hand Delivery", "Pickup"];
  const validItemDiscountType = ["percentage", "currency"];
  const validTransactionDiscountType = ["percentage", "currency"];
  const validPaymentTerms = [
    "Net 15", 
    "Net 30", 
    "Net 45", 
    "Net 60", 
    "Pay Now", 
    "due on receipt", 
    "End of This Month", 
    "End of Next Month"
  ];
  const validCountries = {
    "United Arab Emirates": [
      "Abu Dhabi",
      "Dubai",
      "Sharjah",
      "Ajman",
      "Umm Al-Quwain",
      "Fujairah",
      "Ras Al Khaimah",
    ],
    "India": [
      "Andaman and Nicobar Island",
      "Andhra Pradesh",
      "Arunachal Pradesh",
      "Assam",
      "Bihar",
      "Chandigarh",
      "Chhattisgarh",
      "Dadra and Nagar Haveli and Daman and Diu",
      "Delhi",
      "Goa",
      "Gujarat",
      "Haryana",
      "Himachal Pradesh",
      "Jammu and Kashmir",
      "Jharkhand",
      "Karnataka",
      "Kerala",
      "Ladakh",
      "Lakshadweep",
      "Madhya Pradesh",
      "Maharashtra",
      "Manipur",
      "Meghalaya",
      "Mizoram",
      "Nagaland",
      "Odisha",
      "Puducherry",
      "Punjab",
      "Rajasthan",
      "Sikkim",
      "Tamil Nadu",
      "Telangana",
      "Tripura",
      "Uttar Pradesh",
      "Uttarakhand",
      "West Bengal",
    ],
    "Saudi Arabia": [
      "Asir",
      "Al Bahah",
      "Al Jawf",
      "Al Madinah",
      "Al-Qassim",
      "Eastern Province",
      "Hail",
      "Jazan",
      "Makkah",
      "Medina",
      "Najran",
      "Northern Borders",
      "Riyadh",
      "Tabuk",
    ],
  };
  
  