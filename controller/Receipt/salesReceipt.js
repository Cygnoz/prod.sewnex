const Organization = require("../../database/model/organization");
const Customer = require("../../database/model/customer");
const Invoice = require("../../database/model/salesInvoice")
const Prefix = require("../../database/model/prefix");
const mongoose = require('mongoose');
const SalesReceipt = require('../../database/model/salesReceipt');
const Account = require("../../database/model/account");
const TrialBalance = require("../../database/model/trialBalance");
const CustomerHistory = require("../../database/model/customerHistory");

const moment = require("moment-timezone");

const { cleanData } = require("../../services/cleanData");
const { singleCustomDateTime, multiCustomDateTime } = require("../../services/timeConverter");


// Fetch existing data
const dataExist = async (organizationId, invoice ,customerId) => {
    const invoiceIds = invoice.map(invoices => invoices.invoiceId);    
    const [organizationExists, customerExists , paymentTable , existingPrefix ] = await Promise.all([
      Organization.findOne({ organizationId }, { organizationId: 1, organizationCountry: 1, state: 1, timeZoneExp: 1 }),
      Customer.findOne({ organizationId, _id: customerId  }, { _id: 1, customerDisplayName: 1 }),
      Invoice.find({ organizationId , _id : { $in: invoiceIds}},{ _id: 1, salesInvoice: 1 , salesInvoiceDate: 1 , dueDate:1 , totalAmount: 1 , balanceAmount : 1}),
      Prefix.findOne({ organizationId })  
    ]);    
    return { organizationExists, customerExists, paymentTable , existingPrefix };
};



const receiptDataExist = async ( organizationId, receiptId ) => {    
    const [organizationExists, allReceipt, receipt ] = await Promise.all([
      Organization.findOne({ organizationId },{ timeZoneExp: 1, dateFormatExp: 1, dateSplit: 1, organizationCountry: 1 }).lean(),
      SalesReceipt.find({ organizationId },{ customerId:1, paymentDate:1, paymentMode:1, amountReceived:1, receipt:1, createdDateTime:1})
      .populate('customerId', 'customerDisplayName')    
      .lean(),
      SalesReceipt.findOne({ organizationId , _id: receiptId },{ organizationId:0 })
      .populate('customerId', 'customerDisplayName')    
      .lean(),
    ]);
    return { organizationExists, allReceipt, receipt };
};

// Fetch Acc existing data
const accDataExists = async ( organizationId, depositAccountId, customerId ) => {
  const [ depositAcc, customerAccount ] = await Promise.all([
    Account.findOne({ organizationId , _id: depositAccountId, accountHead: "Asset" }, { _id:1, accountName: 1 }),
    Account.findOne({ organizationId , accountId:customerId },{ _id:1, accountName:1 })
  ]);
  return { depositAcc, customerAccount };
};


//Get journal data
const journalDataExist = async ( organizationId, receiptId ) => {        
  const [organizationExists, receiptJournal ] = await Promise.all([
    Organization.findOne({ organizationId },{ timeZoneExp: 1, dateFormatExp: 1, dateSplit: 1, organizationCountry: 1 })
    .lean(),
    TrialBalance.find({ organizationId: organizationId, operationId : receiptId })
    .populate('accountId', 'accountName')    
    .lean(),
  ]);
  return { organizationExists, receiptJournal };
};





//Add Receipt
exports.addReceipt = async (req, res) => {
  console.log("Add Receipt",req.body);
  try {    
    const { organizationId, id: userId, userName } = req.user; 
    const cleanedData = cleanData(req.body);
    cleanedData.invoice = cleanedData.invoice.filter(invoice => invoice.paymentAmount > 0);
    
    console.log("cleanedData",cleanedData);
    
    const { invoice, amountReceived, customerId } = cleanedData;
    const invoiceIds = invoice.map(invoices => invoices.invoiceId);

    // Check for duplicate billIds
  const uniqueInvoices = new Set(invoiceIds);
  if (uniqueInvoices.size !== invoiceIds.length) {
    return res.status(400).json({ message: "Duplicate invoice found" });
  }

  // Validate customerId
  if (!mongoose.Types.ObjectId.isValid(customerId) || customerId.length !== 24) {
    return res.status(400).json({ message:"Please select a customer" });
  }

  // Validate Invoice IDs
  const invalidInvoices = invoiceIds.filter(invoiceId => !mongoose.Types.ObjectId.isValid(invoiceId) || invoiceId.length !== 24);
  if (invalidInvoices.length > 0) {
    return res.status(400).json({ message: `Invalid invoice IDs: ${invalidInvoices.join(', ')}` });
  }

  // Check if organization and customer exist
  const { organizationExists, customerExists, paymentTable, existingPrefix } = await dataExist(organizationId, invoice, customerId);
  
  const { depositAcc, customerAccount } = await accDataExists( organizationId, cleanedData.depositAccountId, cleanedData.customerId );
  
  // Validate customer and organization
  if (!validateCustomerAndOrganization(organizationExists, customerExists, existingPrefix, res)) return; 
  
  // Validate input values, unpaidBills, and paymentTable
  if (!validateInputs(cleanedData, invoice, paymentTable, organizationExists, depositAcc, customerAccount, res)) return; 

  const updatedData = await calculateTotalPaymentMade(cleanedData, amountReceived );

  // Validate invoices
  const validatedInvoices = validateInvoices(updatedData.invoice);

  // Process invoices
  const paymentResults = await processInvoices(validatedInvoices);
  console.log('Invoice processing complete:', paymentResults);

  //Prefix
  await salesReceiptPrefix(cleanedData, existingPrefix );

  // Re-fetch the updated invoice to get the latest `amountDue` and `balanceAmount`
  await SalesReceipt.find({ _id: { $in: updatedData.invoice.map(receipt => receipt.invoiceId) } });

  cleanedData.createdDateTime = moment.tz(cleanedData.paymentDate, "YYYY-MM-DDTHH:mm:ss.SSS[Z]", organizationExists.timeZoneExp).toISOString();           
    
  const savedReceipt = await createNewReceipt( updatedData, organizationId, userId, userName );  

  // Add entry to Customer History
  const customerHistoryEntry = new CustomerHistory({
    organizationId,
    operationId: savedReceipt._id,
    customerId,
    title: "Payment Receipt Added",
    description: `Payment Receipt ${savedReceipt.receipt} of amount ${savedReceipt.total} created by ${userName}`,
    userId: userId,
    userName: userName,
  });

  await customerHistoryEntry.save();
     
  //Journal
  await journal( savedReceipt, depositAcc, customerAccount );

  //Response with the updated bills and the success message     
  return res.status(200).json({ message: 'Receipt added successfully' });
    
} catch (error) {
  console.error('Error adding receipt:', error);
  res.status(500).json({ message: "Internal server error.", error : error.message, stack: error.stack });
}
};


// Get receipt Journal
exports.receiptJournal = async (req, res) => {
  try {
      const organizationId = req.user.organizationId;
      const { receiptId } = req.params;

      const { receiptJournal } = await journalDataExist( organizationId, receiptId );      

      if (!receiptJournal) {
          return res.status(404).json({
              message: "No Journal found for the Invoice.",
          });
      }

      const transformedJournal = receiptJournal.map(item => {
        return {
            ...item,
            accountId: item.accountId?._id,  
            accountName: item.accountId?.accountName,  
        };
    });    
      
      res.status(200).json(transformedJournal);
  } catch (error) {
      console.error("Error fetching journal:", error);
      res.status(500).json({ message: "Internal server error.", error : error.message, stack: error.stack });
    }
};


//Get all
exports.getAllSalesReceipt = async (req, res) => {
  try {

    const organizationId  = req.user.organizationId;

    const { organizationExists , allReceipt } = await receiptDataExist( organizationId, null );

    if (!organizationExists) {
      return res.status(404).json({ message: "Organization not found" });
    }

    if (!allReceipt) {
      return res.status(404).json({ message: "No Payments found" });
    }
    
    const transformedInvoice = allReceipt.map(data => {
      return {
        ...data,
        customerId: data.customerId?._id,  
        customerDisplayName: data.customerId?.customerDisplayName,  
      };}); 
      
    const formattedObjects = multiCustomDateTime(transformedInvoice, organizationExists.dateFormatExp, organizationExists.timeZoneExp, organizationExists.dateSplit );    
      
    res.status(200).json(formattedObjects);

  } catch (error) {
    console.error("Error fetching purchase paymentMade:", error);
    res.status(500).json({ message: "Internal server error.", error : error.message, stack: error.stack });
  }
};



// Get One Payment Quote
exports.getSalesReceipt = async (req, res) => {
  try {
    const organizationId = req.user.organizationId;
    const  receiptId = req.params.receiptId;

    const { organizationExists , receipt } = await receiptDataExist( organizationId , receiptId );

    if (!organizationExists) {
      return res.status(404).json({ message: "Organization not found" });
    }

    if (!receipt) {
      return res.status(404).json({ message: "No receipt found" });
    }

    const transformedData = {
      ...receipt,
      customerId: receipt.customerId?._id,  
      customerDisplayName: receipt.customerId?.customerDisplayName,
      };  

    const formattedObjects = singleCustomDateTime(transformedData, organizationExists.dateFormatExp, organizationExists.timeZoneExp, organizationExists.dateSplit );        

    res.status(200).json(formattedObjects);
  } catch (error) {
    console.error("Error fetching receipt:", error);
    res.status(500).json({ message: "Internal server error.", error : error.message, stack: error.stack });
  }
};


// Get last debit note prefix
exports.getLastSalesReceiptPrefix = async (req, res) => {
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
      const lastPrefix = series.receipt + series.receiptNum;

      lastPrefix.organizationId = undefined;

      res.status(200).json(lastPrefix);
  } catch (error) {
      console.error("Error fetching accounts:", error);
      res.status(500).json({ message: "Internal server error.", error : error.message, stack: error.stack });
    }
};

// Debit Note Prefix
function salesReceiptPrefix( cleanData, existingPrefix ) {
  const activeSeries = existingPrefix.series.find(series => series.status === true);
  if (!activeSeries) {
      return res.status(404).json({ message: "No active series found for the organization." });
  }
  cleanData.receipt = `${activeSeries.receipt}${activeSeries.receiptNum}`;

  activeSeries.receiptNum += 1;

  existingPrefix.save() 
}







 // Validate Supplier and Organization
 function validateCustomerAndOrganization(organizationExists, customerExists, existingPrefix ,res) {  
  if (!organizationExists) {
      res.status(404).json({ message: "Organization not found" });
      return false;
  }
  if (!customerExists) {
      res.status(404).json({ message: "Customer not found" });
      return false;
  }
  if (!existingPrefix) {
    res.status(404).json({ message: "Prefix not found" });
    return false;
}
  return true;

}





//Validate inputs
function validateInputs( data, invoice, paymentTable, organizationExists, depositAcc, customerAccount, res) {
  const validationErrors = validatePaymentData(data, invoice, paymentTable, organizationExists, depositAcc, customerAccount);

  if (validationErrors.length > 0) {
    res.status(400).json({ message: validationErrors.join(", ") });
    return false;
  }
  return true;
}




// Function to create a new payment record
function createNewReceipt(data, organizationId, userId, userName) {
  const newPayment = new SalesReceipt({
    ...data,
    organizationId,
    userId,
    userName
  });
  return newPayment.save(); // Save the payment to the database
}




//Validate Data
function validatePaymentData( data, invoice, paymentTable, organizationExists, depositAcc, customerAccount ) {
  const errors = [];

  // console.log("invoice Request :",invoice);
  // console.log("invoice Fetched :",paymentTable);
  

  //Basic Info
  validateReqFields( data, depositAcc, customerAccount, errors );
  validatePaymentTable(invoice, paymentTable, errors);
  validateFloatFields([ 'amountReceived','amountUsedForPayments','total'], data, errors);


  //Currency
  // validateCurrency(data.currency, validCurrencies, errors);

  return errors;
}


// Field validation utility
function validateField(condition, errorMsg, errors) {
  if (condition) errors.push(errorMsg);
}

//Valid Req Fields
function validateReqFields( data, depositAcc, customerAccount, errors ) {
  validateField( typeof data.customerId === 'undefined', "Please select a customer", errors  );
  validateField( typeof data.invoice === 'undefined' || (Array.isArray(data.invoice) && data.invoice.length === 0), "Select an invoice", errors  );
  validateField( typeof data.amountReceived === 'undefined' || data.amountReceived === 0 || typeof data.amountUsedForPayments === 'undefined' || data.amountUsedForPayments === 0, "Enter amount received", errors  );
  validateField( typeof data.depositAccountId === 'undefined' , "Select deposit account", errors  );
  validateField( typeof data.paymentMode === 'undefined' , "Select payment mode", errors  );
  validateField( typeof data.paymentDate === 'undefined' , "Select payment date", errors  );
  
  validateField( !depositAcc && typeof data.amountReceived !== 'undefined' , "Deposit Account not found", errors  );
  validateField( !customerAccount && typeof data.amountReceived !== 'undefined' , "Customer Account not found", errors  );
}


// Function to Validate Item Table 
function validatePaymentTable(invoice, paymentTable, errors) {
  // console.log("validate:",invoice , paymentTable)
  // Check for bill count mismatch
  validateField( invoice.length !== paymentTable.length, "Mismatch in invoice count between request and database.", errors  );

  // Iterate through each bills to validate individual fields
  invoice.forEach((invoices) => {
    const fetchedInvoices = paymentTable.find(it => it._id.toString() === invoices.invoiceId);

    // Check if item exists in the item table
    validateField( !fetchedInvoices, `Invoice with ID ${invoices.invoiceId} was not found.`, errors );
    if (!fetchedInvoices) return; 

    // Validate invoice number
    validateField( invoices.salesInvoice !== fetchedInvoices.salesInvoice, `Invoice Number Mismatch Invoice Number: ${invoices.salesInvoice}`, errors );

    // Validate bill date
    validateField( invoices.salesInvoiceDate !== fetchedInvoices.salesInvoiceDate, `Invoice Date Mismatch Invoice Number: ${invoices.salesInvoice} : ${invoices.salesInvoiceDate}` , errors );

    // Validate dueDate
    validateField( invoices.dueDate !== fetchedInvoices.dueDate, `Due Date Mismatch for Invoice Number${invoices.salesInvoice}:  ${invoices.dueDate}`, errors );

    // Validate billAmount
    validateField( invoices.totalAmount !== fetchedInvoices.totalAmount, `Grand Total for Invoice Number${invoices.salesInvoice}: ${invoices.totalAmount}`, errors );
    
    // Validate amountDue
    validateField( invoices.balanceAmount !== fetchedInvoices.balanceAmount, `Amount Due for Invoice number ${invoices.salesInvoice}: ${invoices.balanceAmount}`, errors );

    // Validate float fields
    validateFloatFields(['balanceAmount', 'totalAmount', 'paymentAmount'], invoices, errors);
  });
}




//Valid Float Fields  
function validateFloatFields(fields, data, errors) {
  fields.forEach((balance) => {
    validateField(data[balance] && !isFloat(data[balance]),
      "Invalid " + balance.replace(/([A-Z])/g, " $1") + ": " + data[balance], errors);
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







const calculateAmountDue = async (invoiceId, { amount }) => {
  try {
    // Find the bill by its ID
    const receipt = await Invoice.findById(invoiceId);

    if (!receipt) {
      throw new Error(`Invoice not found with ID: ${invoiceId}`);
    }

    // Initialize fields if undefined
    receipt.paidAmount = typeof receipt.paidAmount === 'number' ? receipt.paidAmount : 0;
    receipt.balanceAmount = typeof receipt.balanceAmount === 'number' ? receipt.balanceAmount : receipt.totalAmount;

    // Calculate new paidAmount and balanceAmount
    receipt.paidAmount += amount;
    receipt.balanceAmount = receipt.totalAmount - receipt.paidAmount;

    // Ensure values are within correct bounds
    if (receipt.balanceAmount < 0) {
      receipt.balanceAmount = 0;
    }
    if (receipt.paidAmount > receipt.totalAmount) {
      receipt.paidAmount = receipt.totalAmount;
    }

    // Save the updated bill with new balanceAmount and paidAmount
    await receipt.save();

    // Log the updated bill status for debugging
    console.log(`Updated Invoice ID ${invoiceId}: Paid Amount: ${receipt.paidAmount}, Balance Amount: ${receipt.balanceAmount}`);

    // Check if payment is complete
    if (receipt.balanceAmount === 0) {
      return {
        message: `Payment completed for Invoice ID ${invoiceId}. No further payments are needed.`,
        receipt,
      };
    }

    return { message: 'Payment processed', receipt };

  } catch (error) {
    console.error(`Error calculating balance amount for Invoice ID ${invoiceId}:`, error);
    throw new Error(`Error calculating balance amount for Invoice ID ${invoiceId}: ${error.message}`);
  }
};



const calculateTotalPaymentMade = async (cleanedData, amountReceived) => {
  let totalPayment = 0;

  // Sum the `payment` amounts from each unpaid bill in the array
  for (const receipt of cleanedData.invoice) {
    totalPayment += receipt.paymentAmount || 0; // Ensure `payment` is a number and add it
  }

  // Assign the total to both `total` and `amountReceived` field in `cleanedData`
  cleanedData.total = totalPayment;
  cleanedData.amountReceived = totalPayment;

  // Calculate amountUsedForPayments and amountInExcess
  amountReceived = cleanedData.amountReceived || 0;
  cleanedData.amountUsedForPayments = totalPayment;

  return cleanedData;
};


// Utility function to validate invoices
function validateInvoices(invoices) {
  return invoices.map(receipt => {
    if (typeof receipt.paymentAmount === 'undefined') {
      console.warn(`Payment field missing for Invoice ID: ${receipt.invoiceId}`);
      receipt.paymentAmount = 0; // Default paymentAmount to 0
    }
    return receipt;
  });
}

// Utility function to process invoices
async function processInvoices(invoices) {
  const results = [];
  for (const invoice of invoices) {
    try {
      const result = await calculateAmountDue(invoice.invoiceId, { amount: invoice.paymentAmount });
      results.push(result);
    } catch (error) {
      console.error(`Error processing Invoice ID: ${invoice.invoiceId}`, error);
      throw error; // Re-throw for higher-level error handling
    }
  }
  return results;
}










async function journal( savedReceipt, depositAcc, customerAccount ) {    
  const customerPaid = {
    organizationId: savedReceipt.organizationId,
    operationId: savedReceipt._id,
    transactionId: savedReceipt.receipt,
    accountId: customerAccount._id || undefined,
    action: "Receipt",
    debitAmount: 0,
    creditAmount: savedReceipt.amountReceived || 0,
    remark: savedReceipt.note,
    createdDateTime:savedReceipt.createdDateTime
  };
  const depositAccount = {
    organizationId: savedReceipt.organizationId,
    operationId: savedReceipt._id,
    transactionId: savedReceipt.receipt,
    accountId: depositAcc._id || undefined,
    action: "Receipt",
    debitAmount: savedReceipt.amountReceived || 0,
    creditAmount: 0,
    remark: savedReceipt.note,
    createdDateTime:savedReceipt.createdDateTime
  };
  

  console.log("customerPaid", customerPaid.debitAmount,  customerPaid.creditAmount);
  console.log("depositAccount", depositAccount.debitAmount,  depositAccount.creditAmount);

  const  debitAmount = customerPaid.debitAmount + depositAccount.debitAmount ;
  const  creditAmount = customerPaid.creditAmount + depositAccount.creditAmount ;

  console.log("Total Debit Amount: ", debitAmount );
  console.log("Total Credit Amount: ", creditAmount );
  
  createTrialEntry( customerPaid )
  createTrialEntry( depositAccount )
}






async function createTrialEntry( data ) {
  const newTrialEntry = new TrialBalance({
      organizationId:data.organizationId,
      operationId:data.operationId,
      transactionId: data.transactionId,
      accountId: data.accountId,
      action: data.action,
      debitAmount: data.debitAmount,
      creditAmount: data.creditAmount,
      remark: data.remark,
      createdDateTime:data.createdDateTime
});

await newTrialEntry.save();

}





exports.dataExist = {
  dataExist,
  receiptDataExist,
  accDataExists,
  journalDataExist
};
exports.validation = {
  validateCustomerAndOrganization, 
  validateInputs,
  validateInvoices
};
exports.calculation = { 
  calculateTotalPaymentMade,
  processInvoices
};
exports.accounts = { 
  journal
};